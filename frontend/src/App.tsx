import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseEther,
} from "viem";
import {
  CONTRACT_ADDRESSES,
  CREATION_FEE,
  NETWORKS,
  type NetworkKey,
} from "./config";
import abiJson from "./abi/RitualPredict.json";
import { MarketRow, type Market } from "./MarketRow";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

const abi = (abiJson as { abi: unknown[] }).abi;

export default function App() {
  const [networkKey, setNetworkKey] = useState<NetworkKey>("localhost");
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const network = NETWORKS[networkKey];
  const contractAddress = CONTRACT_ADDRESSES[networkKey];

  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain: network.chain,
        transport: http(network.chain.rpcUrls.default.http[0]),
      }),
    [network],
  );

  const walletClient = useMemo(() => {
    if (!window.ethereum) return null;
    return createWalletClient({
      chain: network.chain,
      transport: custom(window.ethereum),
    });
  }, [network]);

  const loadMarkets = useCallback(async () => {
    if (!contractAddress) {
      setMarkets([]);
      return;
    }
    setLoading(true);
    setGlobalError(null);
    try {
      const result = (await publicClient.readContract({
        address: contractAddress,
        abi,
        functionName: "getMarkets",
      })) as Market[];
      setMarkets(result);
    } catch (e) {
      setGlobalError(
        e instanceof Error ? e.message : "Failed to load markets from the contract",
      );
    } finally {
      setLoading(false);
    }
  }, [contractAddress, publicClient]);

  useEffect(() => {
    loadMarkets();
  }, [loadMarkets]);

  async function connectWallet() {
    if (!window.ethereum) {
      setGlobalError("No injected wallet found (install MetaMask or similar).");
      return;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as `0x${string}`[];
      setAccount(accounts[0] ?? null);
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : "Wallet connection failed");
    }
  }

  async function handleBet(marketId: bigint, outcomeIndex: number, amountEth: string) {
    if (!walletClient || !account || !contractAddress) throw new Error("Connect a wallet first");
    const hash = await walletClient.writeContract({
      account,
      address: contractAddress,
      abi,
      functionName: "bet",
      args: [marketId, outcomeIndex],
      value: parseEther(amountEth || "0"),
    });
    await publicClient.waitForTransactionReceipt({ hash });
    await loadMarkets();
  }

  async function handleClaim(marketId: bigint) {
    if (!walletClient || !account || !contractAddress) throw new Error("Connect a wallet first");
    const market = markets.find((m) => m.id === marketId);
    const fn = market?.state === 3 ? "claimWinnings" : "claimRefund";
    const hash = await walletClient.writeContract({
      account,
      address: contractAddress,
      abi,
      functionName: fn,
      args: [marketId],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    await loadMarkets();
  }

  async function handleCreate(form: {
    question: string;
    oracleUrl: string;
    jsonPath: string;
    thresholds: string;
    bettingMinutes: string;
    resolveDelayMinutes: string;
  }) {
    if (!walletClient || !account || !contractAddress) throw new Error("Connect a wallet first");
    const thresholds = form.thresholds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => BigInt(s));

    const hash = await walletClient.writeContract({
      account,
      address: contractAddress,
      abi,
      functionName: "createMarket",
      args: [
        {
          question: form.question,
          oracleUrl: form.oracleUrl,
          jsonPath: form.jsonPath,
          thresholds,
          bettingSeconds: BigInt(Math.round(Number(form.bettingMinutes) * 60)),
          resolveDelaySeconds: BigInt(Math.round(Number(form.resolveDelayMinutes) * 60)),
        },
      ],
      value: CREATION_FEE,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    setShowCreate(false);
    await loadMarkets();
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="app-eyebrow">On-chain, self-resolving</p>
          <h1 className="app-title">Ritual Predict</h1>
        </div>
        <div className="app-header__controls">
          <select
            value={networkKey}
            onChange={(e) => setNetworkKey(e.target.value as NetworkKey)}
          >
            {Object.entries(NETWORKS).map(([key, n]) => (
              <option key={key} value={key}>
                {n.label}
              </option>
            ))}
          </select>
          {account ? (
            <span className="app-account">
              {account.slice(0, 6)}\u2026{account.slice(-4)}
            </span>
          ) : (
            <button onClick={connectWallet}>Connect wallet</button>
          )}
        </div>
      </header>

      {!contractAddress && (
        <p className="app-notice">
          No contract address set for {network.label} yet \u2014 fill in
          CONTRACT_ADDRESSES in src/config.ts after deploying.
        </p>
      )}

      <div className="app-toolbar">
        <button onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? "Cancel" : "New market"}
        </button>
        <button onClick={loadMarkets} disabled={loading}>
          {loading ? "Refreshing\u2026" : "Refresh"}
        </button>
      </div>

      {showCreate && <CreateMarketForm onSubmit={handleCreate} />}

      {globalError && <p className="app-error">{globalError}</p>}

      <div className="market-list">
        {markets.length === 0 && !loading && <p className="app-empty">No markets yet. Create one to get started.</p>}
        {markets.map((m) => (
          <MarketRow key={m.id.toString()} market={m} account={account} onBet={handleBet} onClaim={handleClaim} />
        ))}
      </div>
    </div>
  );
}

function CreateMarketForm({
  onSubmit,
}: {
  onSubmit: (form: {
    question: string;
    oracleUrl: string;
    jsonPath: string;
    thresholds: string;
    bettingMinutes: string;
    resolveDelayMinutes: string;
  }) => Promise<void>;
}) {
  const [question, setQuestion] = useState("");
  const [oracleUrl, setOracleUrl] = useState("");
  const [jsonPath, setJsonPath] = useState(".price");
  const [thresholds, setThresholds] = useState("4000");
  const [bettingMinutes, setBettingMinutes] = useState("5");
  const [resolveDelayMinutes, setResolveDelayMinutes] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ question, oracleUrl, jsonPath, thresholds, bettingMinutes, resolveDelayMinutes });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create market");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="create-form" onSubmit={handleSubmit}>
      <label>
        Question
        <input value={question} onChange={(e) => setQuestion(e.target.value)} required />
      </label>
      <label>
        Oracle URL
        <input value={oracleUrl} onChange={(e) => setOracleUrl(e.target.value)} required />
      </label>
      <label>
        JSON path (jq query)
        <input value={jsonPath} onChange={(e) => setJsonPath(e.target.value)} required />
      </label>
      <label>
        Thresholds (comma-separated, ascending)
        <input value={thresholds} onChange={(e) => setThresholds(e.target.value)} required />
      </label>
      <div className="create-form__row">
        <label>
          Betting window (minutes)
          <input value={bettingMinutes} onChange={(e) => setBettingMinutes(e.target.value)} required />
        </label>
        <label>
          Resolve delay (minutes)
          <input value={resolveDelayMinutes} onChange={(e) => setResolveDelayMinutes(e.target.value)} required />
        </label>
      </div>
      <button type="submit" disabled={busy}>
        {busy ? "Creating\u2026" : "Create market (0.01 RITUAL fee)"}
      </button>
      {error && <p className="market-panel__error">{error}</p>}
    </form>
  );
}