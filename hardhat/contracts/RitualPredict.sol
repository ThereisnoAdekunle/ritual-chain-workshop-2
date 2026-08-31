// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RitualChain, IScheduler, IRitualWallet, ITEEServiceRegistry} from "./ritual/RitualChain.sol";

/**
 * RitualPredict — a self-resolving, multi-outcome prediction market.
 *
 * Extension over the workshop starter: markets are no longer fixed to YES/NO. Each
 * market defines a sorted `thresholds[]` array; the single number read from the oracle
 * is bucketed against it into one of `thresholds.length + 1` outcomes. A traditional
 * binary market is just the one-threshold special case (thresholds = [4000] gives you
 * "below 4000" / "at or above 4000") — nothing about the oracle read, the Scheduler
 * booking, or the retry logic changes based on outcome count.
 *
 * Market creation also now charges a flat CREATION_FEE, forwarded immediately to an
 * immutable `treasury` address set at deploy time.
 *
 * Users stake native RITUAL on one outcome. When the betting window closes, the Ritual
 * Scheduler wakes the contract at a block chosen at market-creation time. The contract
 * calls the HTTP precompile (0x0801) to read the configured oracle URL, extracts one
 * number with the jq precompile (0x0803), buckets it against the thresholds, and
 * settles the market.
 *
 * Payouts are pari-mutuel and pull-based: each winner claims
 * `stake * totalPool / winningOutcomePool`. Nothing loops over participants.
 *
 * Every deadline is a BLOCK NUMBER, so "betting is closed" and "the Scheduler woke us"
 * can never disagree. Human durations are converted at `blockTimeMs`, measured from the
 * live chain at deploy time (`scripts/block-time.ts`).
 */
contract RitualPredict {
    // ─────────────────────────────── Types ───────────────────────────────

    enum MarketState {
        Open, // accepting bets
        Closed, // betting window over, waiting for the scheduled wake-up
        Resolving, // a resolution attempt has run and failed; retries pending
        Resolved, // outcome final, winners can claim
        Invalid // could not be resolved (or nobody won); everyone refunds
    }

    /// Storage layout *and* the shape returned by `getMarket` / `getMarkets`.
    struct Market {
        uint256 id;
        address creator;
        string question;
        // ── resolution rule: fixed at creation, no setter exists ──
        string oracleUrl;
        string jsonPath;
        uint256[] thresholds; // sorted ascending; outcomeCount == thresholds.length + 1
        uint64 closeBlock;
        uint64 resolveBlock;
        uint256 scheduleId;
        // ── mutable state ──
        uint256[] totalPerOutcome; // length == thresholds.length + 1
        MarketState state;
        bool hasOutcome;
        uint8 outcomeIndex;
        uint8 attempts;
        uint256 observedValue;
        string invalidReason;
    }

    /// Arguments to `createMarket`, grouped so the whole rule reads as one unit at the
    /// call site (and to keep the stack shallow).
    struct NewMarket {
        string question;
        string oracleUrl;
        string jsonPath;
        uint256[] thresholds;
        uint256 bettingSeconds;
        uint256 resolveDelaySeconds;
    }

    // ────────────────────────────── Constants ────────────────────────────

    /// Resolution attempts per market, booked up front as the Scheduler's `numCalls`,
    /// `RETRY_INTERVAL_BLOCKS` apart. `frequency * numCalls` must stay under the
    /// Scheduler's MAX_LIFESPAN of 10,000.
    uint32 public constant MAX_ATTEMPTS = 3;
    uint32 public constant RETRY_INTERVAL_BLOCKS = 200;

    /// Gas per scheduled execution — one HTTP call, one jq call, a few storage writes.
    uint32 public constant RESOLVE_GAS_LIMIT = 2_000_000;

    /// Scheduler TTL. Must cover trigger drift *and* async HTTP settlement, because the
    /// settlement replay re-runs Scheduler.execute() and re-checks the TTL.
    uint32 public constant SCHEDULER_TTL_BLOCKS = 150;

    /// Blocks the TEE executor has to fulfil the HTTP request.
    uint256 public constant HTTP_TTL_BLOCKS = 100;

    /// Registry slots to probe when picking a TEE executor.
    uint256 public constant EXECUTOR_PROBES = 8;

    /// Floor for the fee authorised per scheduled execution.
    uint256 public constant MIN_MAX_FEE_PER_GAS = 1 gwei;

    uint256 public constant MIN_BETTING_SECONDS = 30;
    uint256 public constant MIN_RESOLVE_DELAY_SECONDS = 15;
    uint256 public constant MAX_MARKET_SECONDS = 1 days;

    /// thresholds.length must be in [MIN_THRESHOLDS, MAX_THRESHOLDS], giving markets
    /// between 2 and 9 outcomes.
    uint256 public constant MIN_THRESHOLDS = 1;
    uint256 public constant MAX_THRESHOLDS = 8;

    /// Flat fee charged at market creation, forwarded to `treasury`.
    uint256 public constant CREATION_FEE = 0.01 ether;

    // ────────────────────────────── Storage ──────────────────────────────

    /// Assumed block time, used only to turn human durations into block counts.
    /// Ritual Chain ran ~195ms when this was written.
    uint256 public immutable blockTimeMs;

    /// Where every creation fee goes. Fixed at deploy time — no setter.
    address public immutable treasury;

    uint256 public marketCount;
    mapping(uint256 => Market) private _markets;

    /// marketId => outcomeIndex => account => staked amount.
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) public stakeOf;
    mapping(uint256 => mapping(address => bool)) public settled;

    // ────────────────────────────── Events ───────────────────────────────

    event MarketCreated(
        uint256 indexed marketId,
        address indexed creator,
        string question,
        uint64 closeBlock,
        uint64 resolveBlock,
        uint256 scheduleId
    );
    /// The resolution rule, emitted separately from MarketCreated. None of these values
    /// can change afterwards — there is no setter.
    event ResolutionRuleSet(
        uint256 indexed marketId,
        string oracleUrl,
        string jsonPath,
        uint256[] thresholds
    );
    event CreationFeeCollected(
        uint256 indexed marketId,
        address indexed treasury,
        uint256 amount
    );
    event BetPlaced(
        uint256 indexed marketId,
        address indexed bettor,
        uint8 outcomeIndex,
        uint256 amount
    );
    event ResolutionAttempted(
        uint256 indexed marketId,
        uint8 attempt,
        address executor
    );
    event ResolutionFailed(
        uint256 indexed marketId,
        uint8 attempt,
        string reason
    );
    event MarketResolved(
        uint256 indexed marketId,
        uint8 outcomeIndex,
        uint256 observedValue
    );
    event MarketInvalidated(uint256 indexed marketId, string reason);
    event WinningsClaimed(
        uint256 indexed marketId,
        address indexed claimant,
        uint256 amount
    );
    event StakeRefunded(
        uint256 indexed marketId,
        address indexed claimant,
        uint256 amount
    );

    // ────────────────────────────── Errors ───────────────────────────────

    error UnknownMarket();
    error OnlyScheduler();
    error BettingClosed();
    error ZeroStake();
    error NotResolved();
    error NotInvalid();
    error NothingToClaim();
    error AlreadySettled();
    error BadDuration();
    error EmptyString();
    error TransferFailed();
    error InvalidThresholds();
    error InvalidOutcome();
    error IncorrectFee();
    error ZeroAddress();

    constructor(uint256 blockTimeMs_, address treasury_) {
        if (blockTimeMs_ == 0) revert BadDuration();
        if (treasury_ == address(0)) revert ZeroAddress();
        blockTimeMs = blockTimeMs_;
        treasury = treasury_;

        // Let the Scheduler call back into this contract and draw execution fees from
        // this contract's RitualWallet balance.
        IScheduler(RitualChain.SCHEDULER).approveScheduler(
            RitualChain.SCHEDULER
        );
    }

    // ───────────────────────── Market lifecycle ──────────────────────────

    /**
     * Create a market and, in the same transaction, book its own resolution with the
     * Scheduler: `MAX_ATTEMPTS` executions starting at `resolveBlock`. Requires exactly
     * CREATION_FEE, forwarded to `treasury`.
     */
    function createMarket(
        NewMarket calldata p
    ) external payable returns (uint256 marketId) {
        if (msg.value != CREATION_FEE) revert IncorrectFee();
        if (bytes(p.question).length == 0) revert EmptyString();
        if (bytes(p.oracleUrl).length == 0) revert EmptyString();
        if (bytes(p.jsonPath).length == 0) revert EmptyString();

        uint256 n = p.thresholds.length;
        if (n < MIN_THRESHOLDS || n > MAX_THRESHOLDS) revert InvalidThresholds();
        for (uint256 i = 1; i < n; i++) {
            if (p.thresholds[i] <= p.thresholds[i - 1]) revert InvalidThresholds();
        }

        if (
            p.bettingSeconds < MIN_BETTING_SECONDS ||
            p.resolveDelaySeconds < MIN_RESOLVE_DELAY_SECONDS ||
            p.bettingSeconds + p.resolveDelaySeconds > MAX_MARKET_SECONDS
        ) revert BadDuration();

        uint64 closeBlock = uint64(
            block.number + _secondsToBlocks(p.bettingSeconds)
        );
        uint64 resolveBlock = closeBlock +
            uint64(_secondsToBlocks(p.resolveDelaySeconds));

        marketId = ++marketCount;
        Market storage m = _markets[marketId];
        m.id = marketId;
        m.creator = msg.sender;
        m.question = p.question;
        m.oracleUrl = p.oracleUrl;
        m.jsonPath = p.jsonPath;
        m.thresholds = p.thresholds;
        m.totalPerOutcome = new uint256[](n + 1);
        m.closeBlock = closeBlock;
        m.resolveBlock = resolveBlock;
        m.state = MarketState.Open;

        // Effects before the external Scheduler call (checks-effects-interactions).
        uint256 scheduleId = _scheduleResolution(marketId, resolveBlock);
        m.scheduleId = scheduleId;

        emit MarketCreated(
            marketId,
            msg.sender,
            p.question,
            closeBlock,
            resolveBlock,
            scheduleId
        );
        emit ResolutionRuleSet(marketId, p.oracleUrl, p.jsonPath, p.thresholds);

        emit CreationFeeCollected(marketId, treasury, msg.value);
        _pay(treasury, msg.value);
    }

    function bet(uint256 marketId, uint8 outcomeIndex) external payable {
        Market storage m = _market(marketId);
        if (msg.value == 0) revert ZeroStake();
        if (outcomeIndex >= m.totalPerOutcome.length) revert InvalidOutcome();
        if (m.state != MarketState.Open || block.number >= m.closeBlock)
            revert BettingClosed();

        stakeOf[marketId][outcomeIndex][msg.sender] += msg.value;
        m.totalPerOutcome[outcomeIndex] += msg.value;

        emit BetPlaced(marketId, msg.sender, outcomeIndex, msg.value);
    }

    /**
     * Scheduler callback. `executionIndex` is written into calldata bytes 4-35 by the
     * Scheduler, so it must be the first parameter.
     *
     * Deliberately revert-free for anything that is not an authorisation failure: a
     * reverted execution would roll back the attempt counter, and the market could then
     * never reach `Invalid`.
     */
    function onScheduledResolve(
        uint256 executionIndex,
        uint256 marketId
    ) external {
        if (msg.sender != RitualChain.SCHEDULER) revert OnlyScheduler();

        Market storage m = _markets[marketId];
        // Unknown market should never happen (we always schedule with a marketId we
        // just created), but this callback must never revert on bad state.
        if (m.closeBlock == 0) return;

        // Idempotent: a leftover retry firing after the market already settled is a
        // harmless no-op, per the design note above.
        if (m.state == MarketState.Resolved || m.state == MarketState.Invalid)
            return;

        if (m.state == MarketState.Open || m.state == MarketState.Closed) {
            m.state = MarketState.Resolving;
        }

        uint8 attempt = m.attempts + 1;
        m.attempts = attempt;

        address executor = _pickExecutor(marketId, executionIndex);
        emit ResolutionAttempted(marketId, attempt, executor);

        if (executor == address(0)) {
            _fail(m, marketId, attempt, "no executor available");
            return;
        }

        (bool ok, uint256 observed, string memory reason) = _readOracle(
            m,
            executor
        );
        if (!ok) {
            _fail(m, marketId, attempt, reason);
            return;
        }

        uint8 idx = _bucket(observed, m.thresholds);
        m.observedValue = observed;
        m.outcomeIndex = idx;
        m.hasOutcome = true;

        uint256 winningPool = m.totalPerOutcome[idx];
        if (winningPool == 0) {
            // Pari-mutuel has no denominator when nobody backed the winning outcome.
            _invalidate(m, marketId, "no stake on winning outcome");
            return;
        }

        m.state = MarketState.Resolved;
        emit MarketResolved(marketId, idx, observed);

        // Resolved early — cancel any remaining booked attempts.
        if (attempt < MAX_ATTEMPTS) {
            IScheduler(RitualChain.SCHEDULER).cancel(m.scheduleId);
        }
    }

    /// A failed oracle read is never interpreted as any outcome. Once the booked
    /// attempts are exhausted the market becomes refundable instead.
    function _fail(
        Market storage m,
        uint256 marketId,
        uint8 attempt,
        string memory reason
    ) private {
        emit ResolutionFailed(marketId, attempt, reason);
        if (attempt >= MAX_ATTEMPTS) _invalidate(m, marketId, reason);
    }

    function _invalidate(
        Market storage m,
        uint256 marketId,
        string memory reason
    ) private {
        m.state = MarketState.Invalid;
        m.invalidReason = reason;
        emit MarketInvalidated(marketId, reason);
    }

    // ────────────────────────────── Payouts ──────────────────────────────

    /// Pull-based, proportional share of the whole pool. No loops over participants.
    function claimWinnings(uint256 marketId) external {
        Market storage m = _market(marketId);
        if (m.state != MarketState.Resolved) revert NotResolved();
        if (settled[marketId][msg.sender]) revert AlreadySettled();

        uint256 payout = _payout(m, marketId, msg.sender);
        if (payout == 0) revert NothingToClaim();

        settled[marketId][msg.sender] = true;
        emit WinningsClaimed(marketId, msg.sender, payout);
        _pay(msg.sender, payout);
    }

    /// Reclaim the original stake (across every outcome) from an invalid market.
    function claimRefund(uint256 marketId) external {
        Market storage m = _market(marketId);
        if (m.state != MarketState.Invalid) revert NotInvalid();
        if (settled[marketId][msg.sender]) revert AlreadySettled();

        uint256 amount = 0;
        uint256 outcomes = m.totalPerOutcome.length;
        for (uint8 i = 0; i < outcomes; i++) {
            amount += stakeOf[marketId][i][msg.sender];
        }
        if (amount == 0) revert NothingToClaim();

        settled[marketId][msg.sender] = true;
        emit StakeRefunded(marketId, msg.sender, amount);
        _pay(msg.sender, amount);
    }

    /// `stake * totalPool / winningOutcomePool`, or 0 if this account didn't back the
    /// winning outcome.
    function _payout(
        Market storage m,
        uint256 marketId,
        address account
    ) private view returns (uint256) {
        uint8 idx = m.outcomeIndex;
        uint256 stake = stakeOf[marketId][idx][account];
        uint256 winningPool = m.totalPerOutcome[idx];
        if (stake == 0 || winningPool == 0) return 0;

        uint256 totalPool = 0;
        uint256 outcomes = m.totalPerOutcome.length;
        for (uint256 i = 0; i < outcomes; i++) totalPool += m.totalPerOutcome[i];

        return (stake * totalPool) / winningPool;
    }

    // ─────────────────────────────── Views ───────────────────────────────

    function getMarket(uint256 marketId) public view returns (Market memory m) {
        m = _markets[marketId];
        if (m.closeBlock == 0) revert UnknownMarket();
        // No transaction exists to flip Open → Closed, so the view does it.
        if (m.state == MarketState.Open && block.number >= m.closeBlock)
            m.state = MarketState.Closed;
    }

    /// Every market, newest first. A workshop has a handful; there is no pagination.
    function getMarkets() external view returns (Market[] memory all) {
        uint256 total = marketCount;
        all = new Market[](total);
        for (uint256 i = 0; i < total; i++) {
            all[i] = getMarket(total - i);
        }
    }

    function outcomeCount(uint256 marketId) external view returns (uint256) {
        return _market(marketId).totalPerOutcome.length;
    }

    function stakeAt(
        uint256 marketId,
        uint8 outcomeIndex,
        address account
    ) external view returns (uint256) {
        return stakeOf[marketId][outcomeIndex][account];
    }

    function claimableFor(
        uint256 marketId,
        address account
    ) external view returns (uint256 claimable, bool alreadySettled) {
        Market storage m = _market(marketId);
        alreadySettled = settled[marketId][account];
        if (alreadySettled) return (0, true);

        if (m.state == MarketState.Resolved) {
            claimable = _payout(m, marketId, account);
        } else if (m.state == MarketState.Invalid) {
            uint256 outcomes = m.totalPerOutcome.length;
            for (uint8 i = 0; i < outcomes; i++) {
                claimable += stakeOf[marketId][i][account];
            }
        }
    }

    // ───────────────────────── Execution funding ─────────────────────────

    /// Prepay Scheduler + HTTP precompile fees. Anyone may top the contract up; the
    /// balance lives in RitualWallet under this contract's address, which is the
    /// `payer` of every scheduled execution.
    function fundExecution(uint256 lockDurationBlocks) external payable {
        if (msg.value == 0) revert ZeroStake();
        IRitualWallet(RitualChain.RITUAL_WALLET).deposit{value: msg.value}(
            lockDurationBlocks
        );
    }

    function executionBalance() external view returns (uint256) {
        return
            IRitualWallet(RitualChain.RITUAL_WALLET).balanceOf(address(this));
    }

    // ───────────────────── Ritual: oracle read path ──────────────────────

    /// HTTP (0x0801) → jq (0x0803), both inside this one scheduled transaction.
    function _readOracle(
        Market storage m,
        address executor
    ) private returns (bool ok, uint256 value, string memory reason) {
        // 13-field HTTP request layout (see ritual-dapp-http skill):
        // executor, encryptedSecrets, ttl, secretSignatures, userPublicKey, url,
        // method, headerKeys, headerValues, body, dkmsKeyIndex, dkmsKeyFormat, piiEnabled
        bytes memory input = abi.encode(
            executor,
            new bytes[](0), // encryptedSecrets — not needed, public oracle
            HTTP_TTL_BLOCKS, // ttl
            new bytes[](0), // secretSignatures
            bytes(""), // userPublicKey — no response encryption
            m.oracleUrl, // url
            RitualChain.HTTP_GET, // method
            new string[](0), // headerKeys
            new string[](0), // headerValues
            bytes(""), // body — GET has none
            uint256(0), // dkmsKeyIndex — not using dKMS
            uint8(0), // dkmsKeyFormat
            false // piiEnabled
        );

        (bool callOk, bytes memory raw) = RitualChain.HTTP_PRECOMPILE.call(
            input
        );
        if (!callOk) return (false, 0, "http precompile call failed");

        // External call through try/catch: malformed/unsettled envelope bytes surface
        // as a caught failure instead of reverting (and rolling back the attempt).
        try this.decodeHttpResponse(raw) returns (
            uint16 status,
            bytes memory body,
            string memory errorMessage
        ) {
            if (bytes(errorMessage).length > 0)
                return (false, 0, errorMessage);
            if (status < 200 || status >= 300)
                return (false, 0, "non-2xx http status");

            (bool jqOk, uint256 observed) = _jqUint(m.jsonPath, string(body));
            if (!jqOk) return (false, 0, "jq extraction failed");

            return (true, observed, "");
        } catch {
            return (false, 0, "malformed http envelope");
        }
    }

    /**
     * Unwraps the short-running async envelope `(bytes simmedInput, bytes actualOutput)`
     * and the 5-field HTTP response inside it.
     *
     * External so `_readOracle` can call it through `try`. Reverting on malformed input
     * is exactly the signal the caller wants.
     */
    function decodeHttpResponse(
        bytes calldata raw
    )
        external
        pure
        returns (uint16 status, bytes memory body, string memory errorMessage)
    {
        (, bytes memory actualOutput) = abi.decode(raw, (bytes, bytes));
        // Empty during simulation, before the executor has run.
        require(actualOutput.length > 0, "async output not settled");
        (status, , , body, errorMessage) = abi.decode(
            actualOutput,
            (uint16, string[], string[], bytes, string)
        );
    }

    /// jq is synchronous. A wrong outputType returns ok=true with zero-length output,
    /// so the length check is load-bearing.
    function _jqUint(
        string memory query,
        string memory json
    ) private view returns (bool, uint256) {
        (bool ok, bytes memory result) = RitualChain.JQ_PRECOMPILE.staticcall(
            abi.encode(query, json, RitualChain.JQ_OUT_UINT256)
        );
        if (!ok || result.length < 32) return (false, 0);
        return (true, abi.decode(result, (uint256)));
    }

    function _pickExecutor(
        uint256 marketId,
        uint256 executionIndex
    ) private view returns (address) {
        // Re-rolled per attempt so one unhealthy executor can't sink a market.
        uint256 seed = uint256(
            keccak256(abi.encode(marketId, executionIndex, block.number))
        );
        (address executor, bool found) = ITEEServiceRegistry(
            RitualChain.TEE_SERVICE_REGISTRY
        ).pickServiceByCapability(
                RitualChain.CAPABILITY_HTTP_CALL,
                true,
                seed,
                EXECUTOR_PROBES
            );
        return found ? executor : address(0);
    }

    // ────────────────────── Ritual: scheduling ───────────────────────────

    function _scheduleResolution(
        uint256 marketId,
        uint64 resolveBlock
    ) private returns (uint256 callId) {
        // The Scheduler overwrites calldata bytes 4-35 with the real executionIndex at
        // execution time — the first real parameter must be a uint256 placeholder.
        bytes memory data = abi.encodeWithSelector(
            this.onScheduledResolve.selector,
            uint256(0),
            marketId
        );

        callId = IScheduler(RitualChain.SCHEDULER).schedule(
            data,
            RESOLVE_GAS_LIMIT,
            uint32(resolveBlock),
            MAX_ATTEMPTS,
            RETRY_INTERVAL_BLOCKS,
            SCHEDULER_TTL_BLOCKS,
            MIN_MAX_FEE_PER_GAS,
            0, // maxPriorityFeePerGas
            0, // value
            address(this) // payer — this contract's RitualWallet balance
        );
    }

    // ────────────────────────────── Helpers ──────────────────────────────

    function _market(uint256 marketId) private view returns (Market storage m) {
        m = _markets[marketId];
        if (m.closeBlock == 0) revert UnknownMarket();
    }

    /// First index i where observed < thresholds[i]; thresholds.length if observed is
    /// at or above every threshold. thresholds is sorted ascending (enforced at
    /// creation), so a single linear scan is correct and cheap for the small arrays
    /// this contract allows (<= MAX_THRESHOLDS).
    function _bucket(
        uint256 observed,
        uint256[] storage thresholds
    ) private view returns (uint8) {
        uint256 n = thresholds.length;
        for (uint256 i = 0; i < n; i++) {
            if (observed < thresholds[i]) return uint8(i);
        }
        return uint8(n);
    }

    function _secondsToBlocks(
        uint256 seconds_
    ) private view returns (uint256 blocks) {
        blocks = (seconds_ * 1000) / blockTimeMs;
        if (blocks == 0) blocks = 1;
    }

    function _pay(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// Scheduler gas refunds land in RitualWallet, but accept plain transfers anyway.
    receive() external payable {}
}
