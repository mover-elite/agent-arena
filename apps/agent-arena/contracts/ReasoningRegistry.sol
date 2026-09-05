// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Differentiator: on-chain reasoning receipts. Commits a hash of an
/// agent's decision (its reasoning text + the fields that made it a trade) to
/// an event log BEFORE the market it traded can settle, so the reasoning
/// shown in the UI is provably the reasoning that was there at trade time —
/// it can't be edited after the fact to look better in hindsight.
///
/// Deliberately stateless: no storage beyond the event log, so committing is
/// as cheap as a single log write can be. Anyone can verify a commitment by
/// re-hashing the decision record from the JSONL log and comparing.
contract ReasoningRegistry {
    event ReasoningCommitted(
        bytes32 indexed agentId,
        bytes32 indexed marketId,
        bytes32 decisionHash,
        uint256 timestamp
    );

    function commitReasoning(bytes32 agentId, bytes32 marketId, bytes32 decisionHash) external {
        emit ReasoningCommitted(agentId, marketId, decisionHash, block.timestamp);
    }
}
