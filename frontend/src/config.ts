import { defineChain } from "viem";

export const localhostChain = defineChain({
  id: 31337,
  name: "Local Hardhat",
  nativeCurrency: { name: "RITUAL", symbol: "RITUAL", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export const ritualChain = defineChain({
  id: 1979,
  name: "Ritual Chain",
  nativeCurrency: { name: "RITUAL", symbol: "RITUAL", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.ritualfoundation.org"] } },
});

export type NetworkKey = "localhost" | "ritual";

export const NETWORKS: Record<
  NetworkKey,
  { label: string; chain: typeof localhostChain }
> = {
  localhost: { label: "Local Hardhat", chain: localhostChain },
  ritual: { label: "Ritual Chain", chain: ritualChain },
};

// Fill these in after deploying to each network — scripts/deploy.ts prints the
// deployed address. Betting/creating will show a clear error until this is set.
export const CONTRACT_ADDRESSES: Record<NetworkKey, `0x${string}` | ""> = {
  localhost: "0x0165878a594ca255338adfa4d48449f69242eb8f",
  ritual: "",
};

// Must match RitualPredict.CREATION_FEE (0.01 ether) in the contract.
export const CREATION_FEE = 10n ** 16n;

export const MARKET_STATE_LABELS = [
  "OPEN",
  "CLOSED",
  "RESOLVING",
  "RESOLVED",
  "VOID",
] as const;