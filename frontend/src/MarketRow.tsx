import { useState } from "react";
import { formatEther } from "viem";
import { MARKET_STATE_LABELS } from "./config";

type Market = {
  id: bigint;
  creator: `0x${string}`;
  question: string;
  oracleUrl: string;
  jsonPath: string;
  thresholds: bigint[];
  closeBlock: bigint;
  resolveBlock: bigint;
  scheduleId: bigint;
  totalPerOutcome: bigint[];
  state: number;
  hasOutcome: boolean;
  outcomeIndex: number;
  attempts: number;
  observedValue: bigint;
  invalidReason: string;
};

function outcomeLabel(market: Market, index: number): string {
  const t = market.thresholds;
  if (index === 0) return `< ${t[0]}`;
  if (index === t.length) return `\u2265 ${t[t.length - 1]}`;
  return `${t[index - 1]} \u2013 ${t[index]}`;
}

function OutcomeBar({ market }: { market: Market }) {
  const total = market.totalPerOutcome.reduce((a, b) => a + b, 0n);

  return (
    <div className="outcome-bar" role="img" aria-label="pool distribution by outcome">
      {market.totalPerOutcome.map((amount, i) => {
        const pct = total === 0n ? 0 : Number((amount * 10000n) / (total || 1n)) / 100;
        const isWinner = market.hasOutcome && market.outcomeIndex === i;
        return (
          <div
            key={i}
            className={`outcome-segment${isWinner ? " outcome-segment--winner" : ""}`}
            style={{ width: `${Math.max(pct, total === 0n ? 100 / market.totalPerOutcome.length : 2)}%` }}
            title={`${outcomeLabel(market, i)}: ${formatEther(amount)} RITUAL`}
          />
        );
      })}
    </div>
  );
}

export function MarketRow({
  market,
  account,
  onBet,
  onClaim,
}: {
  market: Market;
  account: `0x${string}` | null;
  onBet: (marketId: bigint, outcomeIndex: number, amountEth: string) => Promise<void>;
  onClaim: (marketId: bigint) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [outcomeChoice, setOutcomeChoice] = useState(0);
  const [amount, setAmount] = useState("0.01");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stateLabel = MARKET_STATE_LABELS[market.state] ?? "UNKNOWN";
  const canBet = market.state === 0; // Open
  const canClaim = market.state === 3 || market.state === 4; // Resolved or Invalid

  async function handleBet() {
    setBusy(true);
    setError(null);
    try {
      await onBet(market.id, outcomeChoice, amount);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bet failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleClaim() {
    setBusy(true);
    setError(null);
    try {
      await onClaim(market.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Claim failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`market-row market-row--${stateLabel.toLowerCase()}`}>
      <button className="market-row__summary" onClick={() => setExpanded((v) => !v)}>
        <div className="market-row__main">
          <span className="market-row__state">{stateLabel}</span>
          <h3 className="market-row__question">{market.question}</h3>
          <p className="market-row__meta">
            #{market.id.toString()} \u00b7 {market.jsonPath} from {new URL(market.oracleUrl).hostname}
          </p>
        </div>
        <OutcomeBar market={market} />
      </button>

      {expanded && (
        <div className="market-panel">
          <ul className="market-panel__outcomes">
            {market.totalPerOutcome.map((amt, i) => (
              <li key={i} className={market.hasOutcome && market.outcomeIndex === i ? "is-winner" : ""}>
                <span>{outcomeLabel(market, i)}</span>
                <span>{formatEther(amt)} RITUAL</span>
              </li>
            ))}
          </ul>

          {market.hasOutcome && (
            <p className="market-panel__observed">
              Observed value: <strong>{market.observedValue.toString()}</strong>
            </p>
          )}
          {market.state === 4 && market.invalidReason && (
            <p className="market-panel__void-reason">Void: {market.invalidReason}</p>
          )}

          {!account && <p className="market-panel__hint">Connect a wallet to bet or claim.</p>}

          {account && canBet && (
            <div className="market-panel__form">
              <label>
                Outcome
                <select
                  value={outcomeChoice}
                  onChange={(e) => setOutcomeChoice(Number(e.target.value))}
                >
                  {market.totalPerOutcome.map((_, i) => (
                    <option key={i} value={i}>
                      {outcomeLabel(market, i)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Amount (RITUAL)
                <input value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <button disabled={busy} onClick={handleBet}>
                {busy ? "Placing bet\u2026" : "Place bet"}
              </button>
            </div>
          )}

          {account && canClaim && (
            <button disabled={busy} onClick={handleClaim}>
              {busy ? "Claiming\u2026" : market.state === 3 ? "Claim winnings" : "Claim refund"}
            </button>
          )}

          {error && <p className="market-panel__error">{error}</p>}
        </div>
      )}
    </div>
  );
}

export type { Market };