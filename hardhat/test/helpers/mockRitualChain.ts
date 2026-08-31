import type { NetworkConnection } from "hardhat/types/network";

// Real fixed addresses, copied from contracts/ritual/RitualChain.sol — kept here too
// so the test suite has one obvious place to check them against the contract.
export const RITUAL_ADDRESSES = {
  HTTP_PRECOMPILE: "0x0000000000000000000000000000000000000801",
  JQ_PRECOMPILE: "0x0000000000000000000000000000000000000803",
  SCHEDULER: "0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B",
  RITUAL_WALLET: "0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948",
  TEE_SERVICE_REGISTRY: "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F",
} as const;

/**
 * Deploys the mock precompiles/system contracts, then copies each one's bytecode onto
 * its real fixed address with `networkHelpers.setCode`. Any call RitualPredict makes to
 * 0x0801, 0x0803, the Scheduler, the RitualWallet, or the TEEServiceRegistry lands on
 * the corresponding mock afterwards.
 *
 * Also impersonates + funds the Scheduler address so tests can call
 * `onScheduledResolve` directly, as if the real Scheduler had woken the contract.
 */
export async function deployRitualMocks(connection: NetworkConnection) {
  const { viem, networkHelpers } = connection as any;
  const publicClient = await viem.getPublicClient();

  const schedulerMock = await viem.deployContract("MockScheduler");
  const httpMock = await viem.deployContract("MockHttp");
  const jqMock = await viem.deployContract("MockJq");
  const teeMock = await viem.deployContract("MockTeeRegistry");
  const walletMock = await viem.deployContract("MockRitualWallet");

  await plantAt(publicClient, networkHelpers, RITUAL_ADDRESSES.SCHEDULER, schedulerMock.address);
  await plantAt(publicClient, networkHelpers, RITUAL_ADDRESSES.HTTP_PRECOMPILE, httpMock.address);
  await plantAt(publicClient, networkHelpers, RITUAL_ADDRESSES.JQ_PRECOMPILE, jqMock.address);
  await plantAt(publicClient, networkHelpers, RITUAL_ADDRESSES.TEE_SERVICE_REGISTRY, teeMock.address);
  await plantAt(publicClient, networkHelpers, RITUAL_ADDRESSES.RITUAL_WALLET, walletMock.address);

  // Contract handles bound to the REAL addresses, so tests configure the mock through
  // the address RitualPredict will actually call.
  const scheduler = await viem.getContractAt("MockScheduler", RITUAL_ADDRESSES.SCHEDULER);
  const http = await viem.getContractAt("MockHttp", RITUAL_ADDRESSES.HTTP_PRECOMPILE);
  const jq = await viem.getContractAt("MockJq", RITUAL_ADDRESSES.JQ_PRECOMPILE);
  const teeRegistry = await viem.getContractAt("MockTeeRegistry", RITUAL_ADDRESSES.TEE_SERVICE_REGISTRY);
  const wallet = await viem.getContractAt("MockRitualWallet", RITUAL_ADDRESSES.RITUAL_WALLET);

  await networkHelpers.setBalance(RITUAL_ADDRESSES.SCHEDULER, 10n ** 18n);
  await networkHelpers.impersonateAccount(RITUAL_ADDRESSES.SCHEDULER);

  return { scheduler, http, jq, teeRegistry, wallet };
}

/// Calls RitualPredict.onScheduledResolve as if the real Scheduler had triggered it.
export async function fireScheduledResolve(
  connection: NetworkConnection,
  predictAddress: `0x${string}`,
  marketId: bigint,
  executionIndex = 0n,
) {
  const { viem } = connection as any;
  const schedulerWallet = await viem.getWalletClient(RITUAL_ADDRESSES.SCHEDULER);
  const predictAsScheduler = await viem.getContractAt("RitualPredict", predictAddress, {
    client: { wallet: schedulerWallet },
  });
  return predictAsScheduler.write.onScheduledResolve([executionIndex, marketId]);
}

async function plantAt(
  publicClient: any,
  networkHelpers: any,
  targetAddress: string,
  mockAddress: string,
) {
  const bytecode = await publicClient.getCode({ address: mockAddress });
  if (!bytecode) throw new Error(`No bytecode found at mock address ${mockAddress}`);
  await networkHelpers.setCode(targetAddress, bytecode);
}