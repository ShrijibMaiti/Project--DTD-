// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TripLogAnchor
/// @notice Stores hourly Merkle roots of signed GPS ping batches per trip.
///         Raw telemetry never touches the chain — only roots. A single root
///         proves ~120 pings; selective disclosure happens via Merkle proofs.
contract TripLogAnchor {
    // ---------------------------------------------------------------- roles
    address public owner;
    mapping(address => bool) public isAnchorer; // gateway signer service(s)

    // ---------------------------------------------------------------- state
    struct Batch {
        bytes32 root;       // Merkle root of the batch (sorted-pair keccak256)
        uint64 fromTs;      // first ping timestamp in batch (unix seconds)
        uint64 toTs;        // last ping timestamp in batch
        uint64 anchoredAt;  // block timestamp when anchored
    }

    // tripId => ordered list of batches
    mapping(bytes32 => Batch[]) private _batches;

    // ---------------------------------------------------------------- events
    event AnchorerSet(address indexed anchorer, bool allowed);
    event BatchAnchored(
        bytes32 indexed tripId,
        uint256 indexed batchIndex,
        bytes32 root,
        uint64 fromTs,
        uint64 toTs
    );
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ---------------------------------------------------------------- errors
    error NotOwner();
    error NotAnchorer();
    error ZeroRoot();
    error BadTimeRange();
    error TimeOverlap();

    // ---------------------------------------------------------------- modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAnchorer() {
        if (!isAnchorer[msg.sender]) revert NotAnchorer();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------- admin
    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setAnchorer(address anchorer, bool allowed) external onlyOwner {
        isAnchorer[anchorer] = allowed;
        emit AnchorerSet(anchorer, allowed);
    }

    // ---------------------------------------------------------------- write
    /// @notice Anchor one Merkle root covering pings in [fromTs, toTs].
    ///         Batches for a trip must be time-ordered and non-overlapping.
    function anchorBatch(
        bytes32 tripId,
        bytes32 root,
        uint64 fromTs,
        uint64 toTs
    ) external onlyAnchorer returns (uint256 batchIndex) {
        if (root == bytes32(0)) revert ZeroRoot();
        if (toTs < fromTs) revert BadTimeRange();

        Batch[] storage list = _batches[tripId];
        if (list.length > 0 && fromTs <= list[list.length - 1].toTs) {
            revert TimeOverlap();
        }

        list.push(Batch({
            root: root,
            fromTs: fromTs,
            toTs: toTs,
            anchoredAt: uint64(block.timestamp)
        }));

        batchIndex = list.length - 1;
        emit BatchAnchored(tripId, batchIndex, root, fromTs, toTs);
    }

    // ---------------------------------------------------------------- read
    function batchCount(bytes32 tripId) external view returns (uint256) {
        return _batches[tripId].length;
    }

    function getBatch(bytes32 tripId, uint256 index)
        external
        view
        returns (Batch memory)
    {
        return _batches[tripId][index];
    }

    /// @notice Verify a single ping leaf against an anchored batch root.
    /// @dev    Leaf = keccak256 of the canonical serialized ping (built off-chain
    ///         by sdk/merkle.ts). Proof uses sorted-pair hashing to match
    ///         merkletreejs { sortPairs: true }.
    function verifyPing(
        bytes32 tripId,
        uint256 batchIndex,
        bytes32 leaf,
        bytes32[] calldata proof
    ) external view returns (bool) {
        bytes32 root = _batches[tripId][batchIndex].root;
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            computed = computed <= p
                ? keccak256(abi.encodePacked(computed, p))
                : keccak256(abi.encodePacked(p, computed));
        }
        return computed == root;
    }
}