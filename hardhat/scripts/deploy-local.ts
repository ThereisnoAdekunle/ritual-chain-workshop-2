import { network } from "hardhat";

// Run against a persistent local node:
//   Terminal 1: npx hardhat node
//   Terminal 2: npx hardhat run scripts/deploy-local.ts --network localhost
//
// Plants the same mock precompiles/system contracts used in the test suite at their
// real fixed Ritual Chain addresses, then deploys RitualPredict against them. This is
// for LOCAL DEMOING ONLY — scripts/deploy.ts (unmodified) is still the one to use
// against the real Ritual Chain once it's back up, where these addresses have real
// code already.

const RITUAL_ADDRESSES = {
  SCHEDULER: "0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B",
  HTTP_PRECOMPILE: "0x0000000000000000000000000000000000000801",
  JQ_PRECOMPILE: "0x0000000000000000000000000000000000000803",
  RITUAL_WALLET: "0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948",
  TEE_SERVICE_REGISTRY: "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F",
} as const;

async function main() {
  const connection = await network.connect();
  const { viem, provider } = connection as any;
  const publicClient = await viem.getPublicClient();
  const [deployer, treasury] = await viem.getWalletClients();

  async function plant(targetAddress: string, mockContractName: string) {
    const mock = await viem.deployContract(mockContractName);
    const code = await publicClient.getCode({ address: mock.address });
    await provider.request({
      method: "hardhat_setCode",
      params: [targetAddress, code],
    });
    return mock;
  }

  await plant(RITUAL_ADDRESSES.SCHEDULER, "MockScheduler");
  await plant(RITUAL_ADDRESSES.HTTP_PRECOMPILE, "MockHttp");
  await plant(RITUAL_ADDRESSES.JQ_PRECOMPILE, "MockJq");
  await plant(RITUAL_ADDRESSES.TEE_SERVICE_REGISTRY, "MockTeeRegistry");
  await plant(RITUAL_ADDRESSES.RITUAL_WALLET, "MockRitualWallet");

  // Point the mocked TEE registry at the deployer's own address as the "executor" so
  // a later manual resolution (scripts/resolve-local.ts) has somewhere to route to.
  const teeRegistry = await viem.getContractAt(
    "MockTeeRegistry",
    RITUAL_ADDRESSES.TEE_SERVICE_REGISTRY,
  );
  await teeRegistry.write.setExecutor([deployer.account.address, true]);

  await provider.request({
    method: "hardhat_setBalance",
    params: [RITUAL_ADDRESSES.SCHEDULER, "0xDE0B6B3A7640000"], // 1 ether
  });
  await provider.request({
    method: "hardhat_impersonateAccount",
    params: [RITUAL_ADDRESSES.SCHEDULER],
  });

  const predict = await viem.deployContract("RitualPredict", [
    1000n, // blockTimeMs — 1:1 seconds-to-blocks, easy to reason about while demoing
    treasury.account.address,
  ]);

  console.log("\nLocal demo deployment complete.");
  console.log(`  RitualPredict: ${predict.address}`);
  console.log(`  Treasury:      ${treasury.account.address}`);
  console.log(`  Deployer:      ${deployer.account.address}`);
  console.log(
    "\nPaste the RitualPredict address into CONTRACT_ADDRESSES.localhost in frontend/src/config.ts.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});