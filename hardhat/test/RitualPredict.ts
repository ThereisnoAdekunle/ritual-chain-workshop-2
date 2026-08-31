import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther } from "viem";
import { network } from "hardhat";
import { deployRitualMocks, fireScheduledResolve } from "./helpers/mockRitualChain.js";

// blockTimeMs = 1000 makes _secondsToBlocks(seconds) == seconds, so test durations
// map 1:1 onto block counts — no need to reason about Ritual Chain's real ~195ms.
const BLOCK_TIME_MS = 1000n;
const MIN_BETTING_SECONDS = 30n;
const MIN_RESOLVE_DELAY_SECONDS = 15n;

const Comparator = { GT: 0, GTE: 1, LT: 2, LTE: 3 } as const;

describe("RitualPredict", async function () {
  const connection = await network.create();
  const { viem, networkHelpers } = connection as any;
  const publicClient = await viem.getPublicClient();

  async function deployMarketContract() {
    const mocks = await deployRitualMocks(connection);
    const predict = await viem.deployContract("RitualPredict", [BLOCK_TIME_MS]);
    return { predict, mocks };
  }

  async function newMarketArgs(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      question: "Will ETH close >= $4000?",
      oracleUrl: "https://example.com/eth-price",
      jsonPath: ".price",
      target: 4000n,
      comparator: Comparator.GTE,
      bettingSeconds: MIN_BETTING_SECONDS,
      resolveDelaySeconds: MIN_RESOLVE_DELAY_SECONDS,
      ...overrides,
    };
  }

  it("creates a market and books its resolution with the Scheduler", async function () {
    const { predict, mocks } = await deployMarketContract();
    const args = await newMarketArgs();

    await viem.assertions.emit(
      predict.write.createMarket([args]),
      predict,
      "MarketCreated",
    );

    const market = await predict.read.getMarket([1n]);
    assert.equal(market.question, args.question);
    assert.equal(market.state, 0); // Open

    // The Scheduler mock recorded the booked call — decode it to confirm the callback
    // selector and marketId are exactly what _scheduleResolution should have sent.
    const scheduleId = market.scheduleId as bigint;
    const bookedData = (await mocks.scheduler.read.getCallData([scheduleId])) as `0x${string}`;
    assert.ok(bookedData.length > 2, "scheduler should have recorded calldata");
  });

  it("accepts bets while open and rejects them after closeBlock", async function () {
    const { predict } = await deployMarketContract();
    const [, bettorA, bettorB] = await viem.getWalletClients();
    const args = await newMarketArgs();

    await predict.write.createMarket([args]);

    const predictAsA = await viem.getContractAt("RitualPredict", predict.address, {
      client: { wallet: bettorA },
    });
    await predictAsA.write.bet([1n, true], { value: parseEther("1") });

    const [yes, no] = await predict.read.stakesOf([1n, bettorA.account.address]);
    assert.equal(yes, parseEther("1"));
    assert.equal(no, 0n);

    // Fast-forward past closeBlock; betting should now revert.
    await networkHelpers.mine(Number(args.bettingSeconds) + 1);

    const predictAsB = await viem.getContractAt("RitualPredict", predict.address, {
      client: { wallet: bettorB },
    });
    await viem.assertions.revertWithCustomError(
      predictAsB.write.bet([1n, false], { value: parseEther("1") }),
      predict,
      "BettingClosed",
    );
  });

  it("resolves YES and pays out the winning side when the oracle read succeeds", async function () {
    const { predict, mocks } = await deployMarketContract();
    const [, yesBettor, noBettor, executor] = await viem.getWalletClients();
    const args = await newMarketArgs();

    await predict.write.createMarket([args]);

    const predictAsYes = await viem.getContractAt("RitualPredict", predict.address, {
      client: { wallet: yesBettor },
    });
    const predictAsNo = await viem.getContractAt("RitualPredict", predict.address, {
      client: { wallet: noBettor },
    });
    await predictAsYes.write.bet([1n, true], { value: parseEther("1") });
    await predictAsNo.write.bet([1n, false], { value: parseEther("1") });

    // Fast-forward to (and past) resolveBlock.
    const totalDelay = Number(args.bettingSeconds) + Number(args.resolveDelaySeconds) + 1;
    await networkHelpers.mine(totalDelay);

    // Configure the mocks: observed price 4200 >= target 4000 → YES wins.
    await mocks.teeRegistry.write.setExecutor([executor.account.address, true]);
    await mocks.http.write.setResponse([200, "0x7b7d", ""]); // body content unused by MockJq
    await mocks.jq.write.setValue([4200n]);

    await fireScheduledResolve(connection, predict.address, 1n);

    const market = await predict.read.getMarket([1n]);
    assert.equal(market.state, 3); // Resolved
    assert.equal(market.outcome, 1); // Yes
    assert.equal(market.observedValue, 4200n);

    const balanceBefore = await publicClient.getBalance({ address: yesBettor.account.address });
    const hash = await predictAsYes.write.claimWinnings([1n]);
    const receipt = await publicClient.getTransactionReceipt({ hash });
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    const balanceAfter = await publicClient.getBalance({ address: yesBettor.account.address });

    // Pari-mutuel, single winner: payout == whole pool (2 ETH) minus gas.
    assert.equal(balanceAfter, balanceBefore + parseEther("2") - gasCost);
  });

  it("invalidates the market after 3 failed resolution attempts, and refunds stakes", async function () {
    const { predict, mocks } = await deployMarketContract();
    const [, bettor, executor] = await viem.getWalletClients();
    const args = await newMarketArgs();

    await predict.write.createMarket([args]);
    const predictAsBettor = await viem.getContractAt("RitualPredict", predict.address, {
      client: { wallet: bettor },
    });
    await predictAsBettor.write.bet([1n, true], { value: parseEther("1") });

    await networkHelpers.mine(
      Number(args.bettingSeconds) + Number(args.resolveDelaySeconds) + 1,
    );

    await mocks.teeRegistry.write.setExecutor([executor.account.address, true]);
    await mocks.jq.write.setShouldFail([true]); // every jq read fails from here on

    // Simulate the Scheduler's 3 booked attempts, 200 blocks apart in reality — the
    // spacing doesn't matter here since we're calling the callback directly.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await fireScheduledResolve(connection, predict.address, 1n, BigInt(attempt));
    }

    const market = await predict.read.getMarket([1n]);
    assert.equal(market.state, 4); // Invalid
    assert.equal(market.attempts, 3);

    const balanceBefore = await publicClient.getBalance({ address: bettor.account.address });
    const hash = await predictAsBettor.write.claimRefund([1n]);
    const receipt = await publicClient.getTransactionReceipt({ hash });
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    const balanceAfter = await publicClient.getBalance({ address: bettor.account.address });

    assert.equal(balanceAfter, balanceBefore + parseEther("1") - gasCost);
  });

  it("invalidates immediately if the oracle resolves but nobody backed the winning side", async function () {
    const { predict, mocks } = await deployMarketContract();
    const [, noBettor, executor] = await viem.getWalletClients();
    const args = await newMarketArgs();

    await predict.write.createMarket([args]);
    const predictAsNo = await viem.getContractAt("RitualPredict", predict.address, {
      client: { wallet: noBettor },
    });
    await predictAsNo.write.bet([1n, false], { value: parseEther("1") }); // nobody bets YES

    await networkHelpers.mine(
      Number(args.bettingSeconds) + Number(args.resolveDelaySeconds) + 1,
    );

    await mocks.teeRegistry.write.setExecutor([executor.account.address, true]);
    await mocks.http.write.setResponse([200, "0x7b7d", ""]);
    await mocks.jq.write.setValue([4200n]); // still resolves YES (>= 4000), but totalYes == 0

    await fireScheduledResolve(connection, predict.address, 1n);

    const market = await predict.read.getMarket([1n]);
    assert.equal(market.state, 4); // Invalid
    assert.equal(market.outcome, 1); // Yes — recorded even though it became Invalid
  });
});