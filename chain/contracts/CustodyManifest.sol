// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CustodyManifest
/// @notice The custody chain: loader + driver co-sign the piece count at
///         loading; the receiver signs the actual scanned count at unloading.
///         Every loss gets pinned to a signed custody window. Escrow.sol
///         reads isReleasable() from here.
/// @dev    Parties never hold wallets — the keys/signer-service signs the
///         manifest hash after phone-OTP verification, and the platform
///         relays the signature here. ecrecover proves WHO signed regardless
///         of who paid the gas.
contract CustodyManifest {
    // ---------------------------------------------------------------- roles
    address public owner;
    mapping(address => bool) public isPlatform; // backend relayer(s)

    // ---------------------------------------------------------------- types
    enum Status {
        None,       // does not exist
        Created,    // manifest registered, awaiting signatures
        InCustody,  // loader + driver both signed -> goods on the road
        Delivered,  // receiver signed, count matches
        Short,      // receiver signed, count LESS than manifest
        Disputed    // manually escalated
    }

    struct Manifest {
        bytes32 tripId;
        bytes32 manifestHash;   // keccak256 of canonical manifest JSON (piece IDs etc.)
        uint32 pieceCount;      // declared at loading
        uint32 deliveredCount;  // scanned at unloading
        address loader;         // shipper-side signing key
        address driver;         // driver signing key
        address receiver;       // godown signing key
        bool loaderSigned;
        bool driverSigned;
        bool receiverSigned;
        uint64 createdAt;
        uint64 custodyStartAt;  // when driver's custody window opened
        uint64 deliveredAt;
        Status status;
    }

    // manifestId (= manifestHash) => manifest
    mapping(bytes32 => Manifest) private _manifests;

    // ---------------------------------------------------------------- events
    event PlatformSet(address indexed platform, bool allowed);
    event ManifestCreated(
        bytes32 indexed manifestId,
        bytes32 indexed tripId,
        uint32 pieceCount,
        address loader,
        address driver,
        address receiver
    );
    event LoaderSigned(bytes32 indexed manifestId);
    event DriverSigned(bytes32 indexed manifestId);
    event CustodyStarted(bytes32 indexed manifestId, uint64 at);
    event DeliveryConfirmed(
        bytes32 indexed manifestId,
        uint32 deliveredCount,
        Status status
    );
    event ManifestDisputed(bytes32 indexed manifestId);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ---------------------------------------------------------------- errors
    error NotOwner();
    error NotPlatform();
    error AlreadyExists();
    error DoesNotExist();
    error WrongStatus();
    error ZeroAddress();
    error ZeroCount();
    error BadSignature();
    error CountExceedsManifest();

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

    /// @dev What the loader/driver actually sign: bound to this contract +
    ///      chain so a signature can't be replayed elsewhere.
    function loadingDigest(bytes32 manifestId) public view returns (bytes32) {
        return keccak256(abi.encodePacked("DTD_LOADING", block.chainid, address(this), manifestId));
    }

    /// @dev What the receiver signs: includes the delivered count.
    function deliveryDigest(bytes32 manifestId, uint32 deliveredCount)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked("DTD_DELIVERY", block.chainid, address(this), manifestId, deliveredCount)
        );
    }

    // ---------------------------------------------------------------- write
    function createManifest(
        bytes32 manifestId,
        bytes32 tripId,
        uint32 pieceCount,
        address loader,
        address driver,
        address receiver
    ) external onlyPlatform {
        if (_manifests[manifestId].status != Status.None) revert AlreadyExists();
        if (pieceCount == 0) revert ZeroCount();
        if (loader == address(0) || driver == address(0) || receiver == address(0)) {
            revert ZeroAddress();
        }

        _manifests[manifestId] = Manifest({
            tripId: tripId,
            manifestHash: manifestId,
            pieceCount: pieceCount,
            deliveredCount: 0,
            loader: loader,
            driver: driver,
            receiver: receiver,
            loaderSigned: false,
            driverSigned: false,
            receiverSigned: false,
            createdAt: uint64(block.timestamp),
            custodyStartAt: 0,
            deliveredAt: 0,
            status: Status.Created
        });

        emit ManifestCreated(manifestId, tripId, pieceCount, loader, driver, receiver);
    }

    /// @notice Relay the loader's signature over loadingDigest(manifestId).
    function submitLoaderSignature(bytes32 manifestId, bytes calldata sig)
        external
        onlyPlatform
    {
        Manifest storage m = _manifests[manifestId];
        if (m.status != Status.Created) revert WrongStatus();
        if (_recover(loadingDigest(manifestId), sig) != m.loader) revert BadSignature();

        m.loaderSigned = true;
        emit LoaderSigned(manifestId);
        _maybeStartCustody(manifestId, m);
    }

    /// @notice Relay the driver's signature over loadingDigest(manifestId).
    ///         This is the driver ACCEPTING custody of pieceCount pieces.
    function submitDriverSignature(bytes32 manifestId, bytes calldata sig)
        external
        onlyPlatform
    {
        Manifest storage m = _manifests[manifestId];
        if (m.status != Status.Created) revert WrongStatus();
        if (_recover(loadingDigest(manifestId), sig) != m.driver) revert BadSignature();

        m.driverSigned = true;
        emit DriverSigned(manifestId);
        _maybeStartCustody(manifestId, m);
    }

    function _maybeStartCustody(bytes32 manifestId, Manifest storage m) internal {
        if (m.loaderSigned && m.driverSigned) {
            m.status = Status.InCustody;
            m.custodyStartAt = uint64(block.timestamp);
            emit CustodyStarted(manifestId, m.custodyStartAt);
        }
    }

    /// @notice Relay the receiver's signature over the scanned count.
    ///         deliveredCount == pieceCount -> Delivered (releasable).
    ///         deliveredCount <  pieceCount -> Short (payment frozen, loss is
    ///         pinned inside the driver's custody window).
    function confirmDelivery(
        bytes32 manifestId,
        uint32 deliveredCount,
        bytes calldata receiverSig
    ) external onlyPlatform {
        Manifest storage m = _manifests[manifestId];
        if (m.status != Status.InCustody) revert WrongStatus();
        if (deliveredCount > m.pieceCount) revert CountExceedsManifest();
        if (_recover(deliveryDigest(manifestId, deliveredCount), receiverSig) != m.receiver) {
            revert BadSignature();
        }

        m.receiverSigned = true;
        m.deliveredCount = deliveredCount;
        m.deliveredAt = uint64(block.timestamp);
        m.status = deliveredCount == m.pieceCount ? Status.Delivered : Status.Short;

        emit DeliveryConfirmed(manifestId, deliveredCount, m.status);
    }

    /// @notice Manual escalation path (ops dashboard) for contested cases.
    function markDisputed(bytes32 manifestId) external onlyPlatform {
        Manifest storage m = _manifests[manifestId];
        if (m.status == Status.None) revert DoesNotExist();
        m.status = Status.Disputed;
        emit ManifestDisputed(manifestId);
    }

    // ---------------------------------------------------------------- read
    function getManifest(bytes32 manifestId) external view returns (Manifest memory) {
        return _manifests[manifestId];
    }

    function status(bytes32 manifestId) external view returns (Status) {
        return _manifests[manifestId].status;
    }

    /// @notice THE money condition. Escrow.sol refuses to pay unless this is true.
    function isReleasable(bytes32 manifestId) external view returns (bool) {
        Manifest storage m = _manifests[manifestId];
        return m.status == Status.Delivered && m.deliveredCount == m.pieceCount;
    }
}