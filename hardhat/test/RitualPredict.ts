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
const CREATION_FEE = parseEther("0.01");

// Single threshold [4000] gives a 2-outcome market: 0 = below 4000, 1 = at/above 4000.
const OUTCOME_NO = 0;
const OUTCOME_YES = 1;

describe("RitualPredict", async function () {
  const connection = await network.create();
  const { viem, networkHelpers } = connection as any;
  const publicClient = await viem.getPublicClient();
  const [, treasury] = await viem.getWalletClients();

  async function deployMarketContract() {
    const mocks = await deployRitualMocks(connection);
    const predict = await viem.deployContract("RitualPredict", [
      BLOCK_TIME_MS,
      treasury.account.address,
    ]);
    return { predict, mocks };
  }

  async function newMarketArgs(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      question: "Will ETH close >= $4000?",
      oracleUrl: "https://example.com/eth-price",
      jsonPath: ".price",
      thresholds: [4000n],
      bettingSeconds: MIN_BETTING_SECONDS,
      resolveDelaySeconds: MIN_RESOLVE_DELAY_SECONDS,
      ...overrides,
    };
  }

  it("creates a market, books its resolution, and forwards the creation fee to treasury", async function () {
    const { predict, mocks } = await deployMarketContract();
    const args = await newMarketArgs();

    const treasuryBalanceBefore = await publicClient.getBalance({
      address: treasury.account.address,
    });

    await viem.assertions.emit(
      predict.write.createMarket([args], { value: CREATION_FEE }),
      predict,
      "MarketCreated",
    );

    const treasuryBalanceAfter = await publicClient.getBalance({
      address: treasury.account.address,
    });
    assert.equal(treasuryBalanceAfter, treasuryBalanceBefore + CREATION_FEE);

    const market = await predict.read.getMarket([1n]);
    assert.equal(market.question, args.question);
    assert.equal(market.state, 0); // Open
    assert.deepEqual(market.thresholds, args.thresholds);
    assert.equal(market.totalPerOutcome.length, 2); // one threshold -> 2 outcomes

    const scheduleId = market.scheduleId as bigint;
    const bookedData = (await mocks.scheduler.read.getCallData([scheduleId])) as `0x${string}`;
    assert.ok(bookedData.length > 2, "scheduler should have recorded calldata");
  });

  it("rejects createMarket with the wrong fee", async function () {
    const { predict } = await deployMarketContract();
    const args = await newMarketArgs();

    await viem.assertions.revertWithCustomError(
      predict.write.createMarket([args], { value: parseEther("0.005") }),
      predict,
      "IncorrectFee",
    );
  });

  it("accepts bets on a valid outcome while open, rejects bad outcomes and late bets", async function () {
    const { predict } = await deployMarketContract();
    const [, , bettorA, bettorB] = await viem.getWalletClients();
    const args = await newMarketArgs();

    await predict.write.createMarket([args], { value: CREATION_FEE });

    const predictAsA = await viem.getContractAt("RitualPredict", predict.address, {
      client: { wallet: bettorA },
    });
    await predictAsA.write.bet([1n, OUTCOME_YES], { value: parseEther("1") });

    const stake = await predict.read.stakeAt([1n, OUTCOME_YES, bettorA.account.address]);
    assert.equal(stake, parseEther("1"));

    // Outcome index out of range (only 0 and 1 exist for a single-threshold market).
    await viem.assertions.revertWithCustomError(
      predictAsA.write.bet([1n, 2], { value: parseEther("1") }),
      predict,
      "InvalidOutcome",
    );

    // Fast-forward past closeBlock; betting should now revert.
    await networkHelpers.mine(Number(args.bettingSeconds) + 1);

    const predictAsB = await viem.getContractAt("RitualPredict", predict.address, {
      client: { wallet: bettorB },
    });
    await viem.assertions.revertWithCustomError(
      predictAsB.write.bet([1n, OUTCOME_NO], { value: parseEther("1") }),
      predict,
      "BettingClosed",
    );
  });

  it("resolves the correct outcome bucket and pays out the winning side", async function () {
    const { predict, mocks } = await deployMarketContract();
    const [, , yesBettor, noBettor, executor] = await viem.getWalletClients();
    const args = await newMarketArgs();

    await predict.write.createMarket([args], { value: CREATION_FEE });

    const predictAsYes = await viem.getContractAt("RitualPredict", predict.address, {
      client: { wallet: yesBettor },
    });
    const predictAsNo = await viem.getContractAt("RitualPredict", predict.address, {
      client: { wallet: noBettor },
    });
    await predictAsYes.write.bet([1n, OUTCOME_YES], { value: parseEther("1") });
    await predictAsNo.write.bet([1n, OUTCOME_NO], { value: parseEther("1") });

    const totalDelay = Number(args.bettingSeconds) + Number(args.resolveDelaySeconds) + 1;
    await networkHelpers.mine(totalDelay);

    // Observed 4200 is not < threshold 4000, so it lands in the last bucket (index 1 = YES).
    await mocks.teeRegistry.write.setExecutor([executor.account.address, true]);
    await mocks.http.write.setResponse([200, "0x7b7d", ""]); // body content unused by MockJq
    await mocks.jq.write.setValue([4200n]);

    await fireScheduledResolve(connection, predict.address, 1n);

    const market = await predict.read.getMarket([1n]);
    assert.equal(market.state, 3); // Resolved
    assert.equal(market.hasOutcome, true);
    assert.equal(market.outcomeIndex, OUTCOME_YES);
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
    const [, , bettor, , executor] = await viem.getWalletClients();
    const args = await newMarketArgs();

    await predict.write.createMarket([args], { value: CREATION_FEE });
    const predictAsBettor = await viem.getContractAt("RitualPredict", predict.address, {
      client: { wallet: bettor },
    });
    await predictAsBettor.write.bet([1n, OUTCOME_YES], { value: parseEther("1") });

    await networkHelpers.mine(
      Number(args.bettingSeconds) + Number(args.resolveDelaySeconds) + 1,
    );

    await mocks.teeRegistry.write.setExecutor([executor.account.address, true]);
    await mocks.jq.write.setShouldFail([true]); // every jq read fails from here on

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

  it("invalidates immediately if the oracle resolves but nobody backed the winning outcome", async function () {
    const { predict, mocks } = await deployMarketContract();
    const [, , noBettor, , executor] = await viem.getWalletClients();
    const args = await newMarketArgs();

    await predict.write.createMarket([args], { value: CREATION_FEE });
    const predictAsNo = await viem.getContractAt("RitualPredict", predict.address, {
      client: { wallet: noBettor },
    });
    await predictAsNo.write.bet([1n, OUTCOME_NO], { value: parseEther("1") }); // nobody bets YES

    await networkHelpers.mine(
      Number(args.bettingSeconds) + Number(args.resolveDelaySeconds) + 1,
    );

    await mocks.teeRegistry.write.setExecutor([executor.account.address, true]);
    await mocks.http.write.setResponse([200, "0x7b7d", ""]);
    await mocks.jq.write.setValue([4200n]); // still resolves YES bucket, but totalPerOutcome[1] == 0

    await fireScheduledResolve(connection, predict.address, 1n);

    const market = await predict.read.getMarket([1n]);
    assert.equal(market.state, 4); // Invalid
    assert.equal(market.outcomeIndex, OUTCOME_YES); // recorded even though it became Invalid
  });
});