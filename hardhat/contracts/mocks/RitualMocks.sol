// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * Local stand-ins for the Ritual Chain precompiles and system contracts, used only in
 * tests. Each one is deployed normally, then its bytecode is copied onto the real
 * fixed address (0x0801, 0x0803, the Scheduler, the TEEServiceRegistry) with
 * `networkHelpers.setCode`, so RitualPredict's calls to those addresses land here
 * instead of reverting against empty code.
 *
 * None of these ship in the market contract itself — they exist purely so a local
 * Hardhat node can stand in for a chain that (right now) is down.
 */

// ─────────────────────────── Mock Scheduler ────────────────────────────

/// Records every `schedule()` call instead of actually waking anything. Tests trigger
/// the callback themselves by impersonating this contract's own address and calling
/// `onScheduledResolve` directly — see test/helpers/mockRitualChain.ts.
contract MockScheduler {
    struct Call {
        bytes data;
        uint32 gas;
        uint32 startBlock;
        uint32 numCalls;
        uint32 frequency;
        uint32 ttl;
        uint256 maxFeePerGas;
        uint256 maxPriorityFeePerGas;
        uint256 value;
        address payer;
        bool cancelled;
    }

    uint256 public nextCallId = 1;
    mapping(uint256 => Call) public calls;
    mapping(address => mapping(address => bool)) public approvals;

    function schedule(
        bytes calldata data,
        uint32 gas,
        uint32 startBlock,
        uint32 numCalls,
        uint32 frequency,
        uint32 ttl,
        uint256 maxFeePerGas,
        uint256 maxPriorityFeePerGas,
        uint256 value,
        address payer
    ) external returns (uint256 callId) {
        callId = nextCallId++;
        calls[callId] = Call(
            data,
            gas,
            startBlock,
            numCalls,
            frequency,
            ttl,
            maxFeePerGas,
            maxPriorityFeePerGas,
            value,
            payer,
            false
        );
    }

    function cancel(uint256 callId) external {
        calls[callId].cancelled = true;
    }

    function getCallState(uint256 callId) external view returns (uint8) {
        // 0 = active, 1 = cancelled — good enough for tests that don't assert on this.
        return calls[callId].cancelled ? 1 : 0;
    }

    function approveScheduler(address schedulerContract) external {
        approvals[msg.sender][schedulerContract] = true;
    }

    /// Test helper: read back the calldata booked for a given callId, so a test can
    /// decode it and confirm the right marketId / selector was scheduled.
    function getCallData(uint256 callId) external view returns (bytes memory) {
        return calls[callId].data;
    }
}

// ───────────────────────────── Mock HTTP (0x0801) ───────────────────────

/// Stands in for the HTTP precompile. Configurable per-test via setResponse /
/// setUnsettled / setShouldRevert; a plain `call` (not staticcall) from RitualPredict
/// lands on the fallback, matching the precompile's no-selector calling convention.
contract MockHttp {
    uint16 private _status = 200;
    bytes private _body;
    string private _errorMessage;
    bool private _unsettled; // simulates "async output not settled" (empty actualOutput)
    bool private _shouldRevert;

    function setResponse(
        uint16 status,
        bytes calldata body,
        string calldata errorMessage
    ) external {
        _status = status;
        _body = body;
        _errorMessage = errorMessage;
        _unsettled = false;
        _shouldRevert = false;
    }

    function setUnsettled() external {
        _unsettled = true;
    }

    function setShouldRevert(bool v) external {
        _shouldRevert = v;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        if (_shouldRevert) revert("mock http: forced failure");

        bytes memory actualOutput;
        if (!_unsettled) {
            string[] memory emptyHeaders = new string[](0);
            actualOutput = abi.encode(
                _status,
                emptyHeaders,
                emptyHeaders,
                _body,
                _errorMessage
            );
        }
        // simmedInput is unused by decodeHttpResponse — pass empty bytes.
        return abi.encode(bytes(""), actualOutput);
    }
}

// ────────────────────────────── Mock jq (0x0803) ────────────────────────

/// Stands in for the jq precompile. Called via staticcall, so the fallback must not
/// touch storage on the read path — only setValue (a normal call) writes.
contract MockJq {
    uint256 private _value;
    bool private _shouldFail;

    function setValue(uint256 v) external {
        _value = v;
        _shouldFail = false;
    }

    function setShouldFail(bool v) external {
        _shouldFail = v;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        if (_shouldFail) return ""; // zero-length output == _jqUint's failure signal
        return abi.encode(_value);
    }
}

// ───────────────────────── Mock TEEServiceRegistry ──────────────────────

contract MockTeeRegistry {
    address private _executor;
    bool private _found = true;

    function setExecutor(address executor, bool found) external {
        _executor = executor;
        _found = found;
    }

    function pickServiceByCapability(
        uint8,
        bool,
        uint256,
        uint256
    ) external view returns (address, bool) {
        return (_executor, _found);
    }
}

// ─────────────────────────── Mock RitualWallet ──────────────────────────

contract MockRitualWallet {
    mapping(address => uint256) public balances;

    function deposit(uint256) external payable {
        balances[msg.sender] += msg.value;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function lockUntil(address) external pure returns (uint256) {
        return 0;
    }
}
