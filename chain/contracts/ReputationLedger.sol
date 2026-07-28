// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReputationLedger
/// @notice Dual-signed trip attestations: {trip done, on time, dispute-free},
///         signed by BOTH the shipper key and the driver key. Aggregates form
///         a portable track record the driver owns — no platform can inflate
///         it, no driver can wipe it.
contract ReputationLedger {
    // ---------------------------------------------------------------- roles
    address public owner;
    mapping(address => bool) public isPlatform;

    // ---------------------------------------------------------------- types
    struct Attestation {
        bytes32 tripId;
        address driver;
        address shipper;
        bool onTime;
        bool disputeFree;
        uint64 attestedAt;
        bool exists;
    }

    struct Reputation {
        uint32 totalTrips;
        uint32 onTimeTrips;
        uint32 disputeFreeTrips;
    }

    // one attestation per trip
    mapping(bytes32 => Attestation) private _attestations;
    // driver key => aggregate
    mapping(address => Reputation) private _reputation;

    // ---------------------------------------------------------------- events
    event PlatformSet(address indexed platform, bool allowed);
    event TripAttested(
        bytes32 indexed tripId,
        address indexed driver,
        address indexed shipper,
        bool onTime,
        bool disputeFree
    );
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ---------------------------------------------------------------- errors
    error NotOwner();
    error NotPlatform();
    error AlreadyAttested();
    error ZeroAddress();
    error BadSignature();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyPlatform() {
        if (!isPlatform[msg.sender]) revert NotPlatform();
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

    function setPlatform(address platform, bool allowed) external onlyOwner {
        isPlatform[platform] = allowed;
        emit PlatformSet(platform, allowed);
    }

    // ---------------------------------------------------------------- helpers
    function _ethSigned(bytes32 h) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
    }

    function _recover(bytes32 h, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        address signer = ecrecover(_ethSigned(h), v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }

    /// @dev What both parties sign. Bound to chain + contract, replay-safe.
    function attestationDigest(
        bytes32 tripId,
        address driver,
        address shipper,
        bool onTime,
        bool disputeFree
    ) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "DTD_ATTEST",
                block.chainid,
                address(this),
                tripId,
                driver,
                shipper,
                onTime,
                disputeFree
            )
        );
    }

    // ---------------------------------------------------------------- write
    function attest(
        bytes32 tripId,
        address driver,
        address shipper,
        bool onTime,
        bool disputeFree,
        bytes calldata driverSig,
        bytes calldata shipperSig
    ) external onlyPlatform {
        if (_attestations[tripId].exists) revert AlreadyAttested();
        if (driver == address(0) || shipper == address(0)) revert ZeroAddress();

        bytes32 digest = attestationDigest(tripId, driver, shipper, onTime, disputeFree);
        if (_recover(digest, driverSig) != driver) revert BadSignature();
        if (_recover(digest, shipperSig) != shipper) revert BadSignature();

        _attestations[tripId] = Attestation({
            tripId: tripId,
            driver: driver,
            shipper: shipper,
            onTime: onTime,
            disputeFree: disputeFree,
            attestedAt: uint64(block.timestamp),
            exists: true
        });

        Reputation storage rep = _reputation[driver];
        rep.totalTrips += 1;
        if (onTime) rep.onTimeTrips += 1;
        if (disputeFree) rep.disputeFreeTrips += 1;

        emit TripAttested(tripId, driver, shipper, onTime, disputeFree);
    }

    // ---------------------------------------------------------------- read
    function getAttestation(bytes32 tripId) external view returns (Attestation memory) {
        return _attestations[tripId];
    }

    /// @notice The portable track record. Any platform, lender, or insurer
    ///         can read this for any driver key — no permission needed.
    function getReputation(address driver) external view returns (Reputation memory) {
        return _reputation[driver];
    }
}