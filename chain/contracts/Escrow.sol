// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICustodyManifest {
    function isReleasable(bytes32 manifestId) external view returns (bool);
    function status(bytes32 manifestId) external view returns (uint8);
}

/// @title Escrow
/// @notice Holds trip payment and releases it ONLY when CustodyManifest says
///         the scanned count matches the manifest count. No full scan at the
///         godown -> no money. This is what makes scanning discipline
///         financially self-enforcing.
/// @dev    Native-token escrow (works with test/main net token; INR rails via
///         Razorpay mirror these conditions off-chain through the same
///         isReleasable() check — see custody/reconcile/release-gate.ts).
contract Escrow {
    // ---------------------------------------------------------------- roles
    address public owner;
    address public arbiter; // ops/dispute resolver (multisig in production)
    ICustodyManifest public immutable custody;

    // ---------------------------------------------------------------- types
    enum DepositStatus { None, Funded, Released, Refunded }

    struct Deposit {
        address payer;   // shipper/transporter side
        address payee;   // driver/fleet-owner side
        uint256 amount;
        DepositStatus status;
        uint64 fundedAt;
    }

    // manifestId => deposit
    mapping(bytes32 => Deposit) private _deposits;

    // CustodyManifest.Status enum mirror (for dispute checks)
    uint8 private constant STATUS_SHORT = 4;
    uint8 private constant STATUS_DISPUTED = 5;

    // ---------------------------------------------------------------- events
    event Funded(bytes32 indexed manifestId, address payer, address payee, uint256 amount);
    event Released(bytes32 indexed manifestId, address payee, uint256 amount);
    event Refunded(bytes32 indexed manifestId, address payer, uint256 amount);
    event ArbiterSet(address indexed arbiter);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ---------------------------------------------------------------- errors
    error NotOwner();
    error NotArbiter();
    error ZeroAmount();
    error ZeroAddress();
    error AlreadyFunded();
    error NotFunded();
    error NotReleasable();
    error NotDisputeState();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }

    constructor(address custodyManifest, address arbiter_) {
        if (custodyManifest == address(0) || arbiter_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        custody = ICustodyManifest(custodyManifest);
        arbiter = arbiter_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ArbiterSet(arbiter_);
    }

    // ---------------------------------------------------------------- admin
    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setArbiter(address newArbiter) external onlyOwner {
        if (newArbiter == address(0)) revert ZeroAddress();
        arbiter = newArbiter;
        emit ArbiterSet(newArbiter);
    }

    // ---------------------------------------------------------------- write
    /// @notice Fund the escrow for a manifest. One deposit per manifest.
    function fund(bytes32 manifestId, address payee) external payable {
        if (msg.value == 0) revert ZeroAmount();
        if (payee == address(0)) revert ZeroAddress();
        if (_deposits[manifestId].status != DepositStatus.None) revert AlreadyFunded();

        _deposits[manifestId] = Deposit({
            payer: msg.sender,
            payee: payee,
            amount: msg.value,
            status: DepositStatus.Funded,
            fundedAt: uint64(block.timestamp)
        });

        emit Funded(manifestId, msg.sender, payee, msg.value);
    }

    /// @notice Anyone may trigger release — the CONDITION is the gate, not the caller.
    function release(bytes32 manifestId) external {
        Deposit storage d = _deposits[manifestId];
        if (d.status != DepositStatus.Funded) revert NotFunded();
        if (!custody.isReleasable(manifestId)) revert NotReleasable();

        d.status = DepositStatus.Released;
        (bool ok, ) = d.payee.call{value: d.amount}("");
        if (!ok) revert TransferFailed();

        emit Released(manifestId, d.payee, d.amount);
    }

    /// @notice Dispute path: only for Short/Disputed manifests, only by arbiter.
    ///         splitToPayee = how much of the deposit the payee still earns
    ///         (e.g. freight for the 175 delivered pieces); remainder refunds payer.
    function resolveDispute(bytes32 manifestId, uint256 splitToPayee) external onlyArbiter {
        Deposit storage d = _deposits[manifestId];
        if (d.status != DepositStatus.Funded) revert NotFunded();

        uint8 s = custody.status(manifestId);
        if (s != STATUS_SHORT && s != STATUS_DISPUTED) revert NotDisputeState();
        if (splitToPayee > d.amount) revert ZeroAmount();

        d.status = DepositStatus.Refunded;
        uint256 toPayer = d.amount - splitToPayee;

        if (splitToPayee > 0) {
            (bool ok1, ) = d.payee.call{value: splitToPayee}("");
            if (!ok1) revert TransferFailed();
            emit Released(manifestId, d.payee, splitToPayee);
        }
        if (toPayer > 0) {
            (bool ok2, ) = d.payer.call{value: toPayer}("");
            if (!ok2) revert TransferFailed();
            emit Refunded(manifestId, d.payer, toPayer);
        }
    }

    // ---------------------------------------------------------------- read
    function getDeposit(bytes32 manifestId) external view returns (Deposit memory) {
        return _deposits[manifestId];
    }
}