// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DocumentRegistry
/// @notice Fingerprints of Bilty / POD / Invoice / Manifest documents.
///         The file itself lives encrypted off-chain (IPFS/S3); the chain
///         stores only its keccak256 content hash. A duplicate registration
///         reverts — which is exactly the duplicate-invoice-financing check.
contract DocumentRegistry {
    // ---------------------------------------------------------------- roles
    address public owner;
    mapping(address => bool) public isRegistrar; // platform backend service(s)

    // ---------------------------------------------------------------- types
    enum DocType { Manifest, Bilty, POD, Invoice }

    struct Doc {
        bytes32 tripId;
        DocType docType;
        address submitter;
        uint64 registeredAt;
        bool exists;
    }

    // docHash (keccak256 of file bytes) => record
    mapping(bytes32 => Doc) private _docs;

    // tripId => docHashes registered under that trip
    mapping(bytes32 => bytes32[]) private _tripDocs;

    // ---------------------------------------------------------------- events
    event RegistrarSet(address indexed registrar, bool allowed);
    event DocumentRegistered(
        bytes32 indexed docHash,
        bytes32 indexed tripId,
        DocType docType,
        address submitter
    );
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ---------------------------------------------------------------- errors
    error NotOwner();
    error NotRegistrar();
    error ZeroHash();
    error AlreadyRegistered(); // <- fires on duplicate financing attempts

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyRegistrar() {
        if (!isRegistrar[msg.sender]) revert NotRegistrar();
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

    function setRegistrar(address registrar, bool allowed) external onlyOwner {
        isRegistrar[registrar] = allowed;
        emit RegistrarSet(registrar, allowed);
    }

    // ---------------------------------------------------------------- write
    function registerDocument(
        bytes32 docHash,
        bytes32 tripId,
        DocType docType
    ) external onlyRegistrar {
        if (docHash == bytes32(0)) revert ZeroHash();
        if (_docs[docHash].exists) revert AlreadyRegistered();

        _docs[docHash] = Doc({
            tripId: tripId,
            docType: docType,
            submitter: msg.sender,
            registeredAt: uint64(block.timestamp),
            exists: true
        });
        _tripDocs[tripId].push(docHash);

        emit DocumentRegistered(docHash, tripId, docType, msg.sender);
    }

    // ---------------------------------------------------------------- read
    /// @notice The 2-second bank/insurer check: "is this exact file genuine?"
    function isRegistered(bytes32 docHash) external view returns (bool) {
        return _docs[docHash].exists;
    }

    function getDocument(bytes32 docHash) external view returns (Doc memory) {
        return _docs[docHash];
    }

    function tripDocumentCount(bytes32 tripId) external view returns (uint256) {
        return _tripDocs[tripId].length;
    }

    function tripDocumentAt(bytes32 tripId, uint256 index)
        external
        view
        returns (bytes32)
    {
        return _tripDocs[tripId][index];
    }
}