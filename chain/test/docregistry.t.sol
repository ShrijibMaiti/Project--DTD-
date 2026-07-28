// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/DocumentRegistry.sol";

/// @notice Invariants under test:
///   1. Only authorized registrars write.
///   2. A document hash registers EXACTLY once — the duplicate-invoice-
///      financing guard. Same file, second attempt, anywhere: revert.
///   3. Trip indexing is complete and ordered.
contract DocumentRegistryTest is Test {
    DocumentRegistry registry;

    address registrar;
    address stranger;

    bytes32 constant TRIP = keccak256("trip-001");
    bytes32 constant OTHER_TRIP = keccak256("trip-002");

    function setUp() public {
        registrar = makeAddr("registrar");
        stranger = makeAddr("stranger");

        registry = new DocumentRegistry();
        registry.setRegistrar(registrar, true);
    }

    // ---------------------------------------------------------------- access control

    function test_RevertWhen_StrangerRegisters() public {
        vm.prank(stranger);
        vm.expectRevert(DocumentRegistry.NotRegistrar.selector);
        registry.registerDocument(keccak256("bilty.pdf"), TRIP, DocumentRegistry.DocType.Bilty);
    }

    function test_RevertWhen_NonOwnerSetsRegistrar() public {
        vm.prank(stranger);
        vm.expectRevert(DocumentRegistry.NotOwner.selector);
        registry.setRegistrar(stranger, true);
    }

    function test_RevokedRegistrarCannotRegister() public {
        registry.setRegistrar(registrar, false);
        vm.prank(registrar);
        vm.expectRevert(DocumentRegistry.NotRegistrar.selector);
        registry.registerDocument(keccak256("doc"), TRIP, DocumentRegistry.DocType.POD);
    }

    // ---------------------------------------------------------------- registration

    function test_RegisterHappyPath() public {
        bytes32 h = keccak256("bilty-file-bytes");

        vm.prank(registrar);
        registry.registerDocument(h, TRIP, DocumentRegistry.DocType.Bilty);

        assertTrue(registry.isRegistered(h));

        DocumentRegistry.Doc memory d = registry.getDocument(h);
        assertEq(d.tripId, TRIP);
        assertEq(uint8(d.docType), uint8(DocumentRegistry.DocType.Bilty));
        assertEq(d.submitter, registrar);
        assertTrue(d.exists);
        assertGt(d.registeredAt, 0);
    }

    function test_UnregisteredHashIsFalse() public view {
        // the "edited by one byte" case: different bytes -> different hash -> not registered
        assertFalse(registry.isRegistered(keccak256("never-anchored")));
    }

    function test_RevertWhen_ZeroHash() public {
        vm.prank(registrar);
        vm.expectRevert(DocumentRegistry.ZeroHash.selector);
        registry.registerDocument(bytes32(0), TRIP, DocumentRegistry.DocType.Invoice);
    }

    // ---------------------------------------------------------------- THE duplicate guard

    function test_RevertWhen_DuplicateHash() public {
        bytes32 h = keccak256("invoice-42");

        vm.startPrank(registrar);
        registry.registerDocument(h, TRIP, DocumentRegistry.DocType.Invoice);
        vm.expectRevert(DocumentRegistry.AlreadyRegistered.selector);
        registry.registerDocument(h, TRIP, DocumentRegistry.DocType.Invoice);
        vm.stopPrank();
    }

    function test_RevertWhen_DuplicateAcrossTrips() public {
        // same invoice pledged under a DIFFERENT trip: still blocked.
        // This is the duplicate-invoice-financing fraud check in one test.
        bytes32 h = keccak256("invoice-42");

        vm.startPrank(registrar);
        registry.registerDocument(h, TRIP, DocumentRegistry.DocType.Invoice);
        vm.expectRevert(DocumentRegistry.AlreadyRegistered.selector);
        registry.registerDocument(h, OTHER_TRIP, DocumentRegistry.DocType.Invoice);
        vm.stopPrank();
    }

    function test_RevertWhen_DuplicateByAnotherRegistrar() public {
        // a second authorized registrar can't re-register either
        address registrar2 = makeAddr("registrar2");
        registry.setRegistrar(registrar2, true);

        bytes32 h = keccak256("pod-7");
        vm.prank(registrar);
        registry.registerDocument(h, TRIP, DocumentRegistry.DocType.POD);

        vm.prank(registrar2);
        vm.expectRevert(DocumentRegistry.AlreadyRegistered.selector);
        registry.registerDocument(h, TRIP, DocumentRegistry.DocType.POD);
    }

    // ---------------------------------------------------------------- trip index

    function test_TripIndexOrderedAndComplete() public {
        bytes32 h0 = keccak256("manifest");
        bytes32 h1 = keccak256("bilty");
        bytes32 h2 = keccak256("pod");

        vm.startPrank(registrar);
        registry.registerDocument(h0, TRIP, DocumentRegistry.DocType.Manifest);
        registry.registerDocument(h1, TRIP, DocumentRegistry.DocType.Bilty);
        registry.registerDocument(h2, TRIP, DocumentRegistry.DocType.POD);
        vm.stopPrank();

        assertEq(registry.tripDocumentCount(TRIP), 3);
        assertEq(registry.tripDocumentAt(TRIP, 0), h0);
        assertEq(registry.tripDocumentAt(TRIP, 1), h1);
        assertEq(registry.tripDocumentAt(TRIP, 2), h2);
        assertEq(registry.tripDocumentCount(OTHER_TRIP), 0);
    }

    // ---------------------------------------------------------------- fuzz

    /// @dev ANY two distinct hashes both register; ANY duplicate reverts.
    function testFuzz_UniquenessInvariant(bytes32 h1, bytes32 h2, uint8 t1, uint8 t2) public {
        vm.assume(h1 != bytes32(0) && h2 != bytes32(0) && h1 != h2);
        DocumentRegistry.DocType d1 = DocumentRegistry.DocType(bound(t1, 0, 3));
        DocumentRegistry.DocType d2 = DocumentRegistry.DocType(bound(t2, 0, 3));

        vm.startPrank(registrar);
        registry.registerDocument(h1, TRIP, d1);
        registry.registerDocument(h2, OTHER_TRIP, d2);

        vm.expectRevert(DocumentRegistry.AlreadyRegistered.selector);
        registry.registerDocument(h1, OTHER_TRIP, d2);

        vm.expectRevert(DocumentRegistry.AlreadyRegistered.selector);
        registry.registerDocument(h2, TRIP, d1);
        vm.stopPrank();

        assertTrue(registry.isRegistered(h1));
        assertTrue(registry.isRegistered(h2));
    }

    /// @dev Trip index count always equals number of successful registrations.
    function testFuzz_TripIndexCount(uint8 n) public {
        n = uint8(bound(n, 1, 32));
        vm.startPrank(registrar);
        for (uint256 i = 0; i < n; i++) {
            registry.registerDocument(
                keccak256(abi.encodePacked("doc", i)),
                TRIP,
                DocumentRegistry.DocType(i % 4)
            );
        }
        vm.stopPrank();
        assertEq(registry.tripDocumentCount(TRIP), n);
    }
}