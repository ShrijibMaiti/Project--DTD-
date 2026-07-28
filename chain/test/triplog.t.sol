// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/TripLogAnchor.sol";

/// @notice Invariants under test:
///   1. Only authorized anchorers write; batches are time-ordered, never overlapping.
///   2. verifyPing accepts exactly the leaves under an anchored root — and
///      rejects tampered leaves, wrong proofs, and cross-batch confusion.
contract TripLogAnchorTest is Test {
    TripLogAnchor anchorContract;

    address anchorer;
    address stranger;

    bytes32 constant TRIP = keccak256("trip-001");
    bytes32 constant OTHER_TRIP = keccak256("trip-002");

    function setUp() public {
        anchorer = makeAddr("anchorer");
        stranger = makeAddr("stranger");

        anchorContract = new TripLogAnchor();
        anchorContract.setAnchorer(anchorer, true);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Sorted-pair keccak256 — byte-identical to the contract and to
    ///      merkletreejs { sortPairs: true }.
    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Build a 4-leaf tree; returns root. Leaves are arbitrary bytes32
    ///      (in production: keccak256 of canonical serialized pings).
    function _root4(bytes32 l0, bytes32 l1, bytes32 l2, bytes32 l3)
        internal
        pure
        returns (bytes32)
    {
        return _pair(_pair(l0, l1), _pair(l2, l3));
    }

    // ---------------------------------------------------------------- access control

    function test_OwnerCanSetAnchorer() public {
        address a2 = makeAddr("anchorer2");
        anchorContract.setAnchorer(a2, true);
        assertTrue(anchorContract.isAnchorer(a2));
    }

    function test_RevertWhen_NonOwnerSetsAnchorer() public {
        vm.prank(stranger);
        vm.expectRevert(TripLogAnchor.NotOwner.selector);
        anchorContract.setAnchorer(stranger, true);
    }

    function test_RevertWhen_StrangerAnchors() public {
        vm.prank(stranger);
        vm.expectRevert(TripLogAnchor.NotAnchorer.selector);
        anchorContract.anchorBatch(TRIP, keccak256("root"), 1000, 2000);
    }

    function test_RevokedAnchorerCannotAnchor() public {
        anchorContract.setAnchorer(anchorer, false);
        vm.prank(anchorer);
        vm.expectRevert(TripLogAnchor.NotAnchorer.selector);
        anchorContract.anchorBatch(TRIP, keccak256("root"), 1000, 2000);
    }

    function test_OwnershipTransfer() public {
        address newOwner = makeAddr("newOwner");
        anchorContract.transferOwnership(newOwner);
        assertEq(anchorContract.owner(), newOwner);

        // old owner is now powerless
        vm.expectRevert(TripLogAnchor.NotOwner.selector);
        anchorContract.setAnchorer(stranger, true);
    }

    // ---------------------------------------------------------------- anchoring rules

    function test_AnchorHappyPath() public {
        vm.prank(anchorer);
        uint256 idx = anchorContract.anchorBatch(TRIP, keccak256("r0"), 1000, 1999);
        assertEq(idx, 0);
        assertEq(anchorContract.batchCount(TRIP), 1);

        TripLogAnchor.Batch memory b = anchorContract.getBatch(TRIP, 0);
        assertEq(b.root, keccak256("r0"));
        assertEq(b.fromTs, 1000);
        assertEq(b.toTs, 1999);
        assertGt(b.anchoredAt, 0);
    }

    function test_SequentialIndices() public {
        vm.startPrank(anchorer);
        assertEq(anchorContract.anchorBatch(TRIP, keccak256("r0"), 1000, 1999), 0);
        assertEq(anchorContract.anchorBatch(TRIP, keccak256("r1"), 2000, 2999), 1);
        assertEq(anchorContract.anchorBatch(TRIP, keccak256("r2"), 3000, 3999), 2);
        vm.stopPrank();
        assertEq(anchorContract.batchCount(TRIP), 3);
    }

    function test_RevertWhen_ZeroRoot() public {
        vm.prank(anchorer);
        vm.expectRevert(TripLogAnchor.ZeroRoot.selector);
        anchorContract.anchorBatch(TRIP, bytes32(0), 1000, 2000);
    }

    function test_RevertWhen_ToBeforeFrom() public {
        vm.prank(anchorer);
        vm.expectRevert(TripLogAnchor.BadTimeRange.selector);
        anchorContract.anchorBatch(TRIP, keccak256("r"), 2000, 1000);
    }

    function test_SinglePointRangeAllowed() public {
        // fromTs == toTs is a valid (single-instant) batch
        vm.prank(anchorer);
        anchorContract.anchorBatch(TRIP, keccak256("r"), 1500, 1500);
        assertEq(anchorContract.batchCount(TRIP), 1);
    }

    function test_RevertWhen_Overlap() public {
        vm.startPrank(anchorer);
        anchorContract.anchorBatch(TRIP, keccak256("r0"), 1000, 1999);
        vm.expectRevert(TripLogAnchor.TimeOverlap.selector);
        anchorContract.anchorBatch(TRIP, keccak256("r1"), 1500, 2500);
        vm.stopPrank();
    }

    function test_RevertWhen_BoundaryTouch() public {
        // fromTs == previous toTs must ALSO revert (strictly increasing windows)
        vm.startPrank(anchorer);
        anchorContract.anchorBatch(TRIP, keccak256("r0"), 1000, 1999);
        vm.expectRevert(TripLogAnchor.TimeOverlap.selector);
        anchorContract.anchorBatch(TRIP, keccak256("r1"), 1999, 2999);
        vm.stopPrank();
    }

    function test_TripsAreIndependent() public {
        // overlap rule applies PER TRIP, not globally
        vm.startPrank(anchorer);
        anchorContract.anchorBatch(TRIP, keccak256("r0"), 1000, 1999);
        anchorContract.anchorBatch(OTHER_TRIP, keccak256("r1"), 1000, 1999); // same window, other trip
        vm.stopPrank();
        assertEq(anchorContract.batchCount(TRIP), 1);
        assertEq(anchorContract.batchCount(OTHER_TRIP), 1);
    }

    // ---------------------------------------------------------------- verifyPing

    function test_VerifyPing_TwoLeafTree() public {
        bytes32 l0 = keccak256("ping-0");
        bytes32 l1 = keccak256("ping-1");
        bytes32 root = _pair(l0, l1);

        vm.prank(anchorer);
        anchorContract.anchorBatch(TRIP, root, 1000, 1999);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = l1;
        assertTrue(anchorContract.verifyPing(TRIP, 0, l0, proof));

        proof[0] = l0;
        assertTrue(anchorContract.verifyPing(TRIP, 0, l1, proof));
    }

    function test_VerifyPing_FourLeafTree() public {
        bytes32 l0 = keccak256("ping-0");
        bytes32 l1 = keccak256("ping-1");
        bytes32 l2 = keccak256("ping-2");
        bytes32 l3 = keccak256("ping-3");
        bytes32 root = _root4(l0, l1, l2, l3);

        vm.prank(anchorer);
        anchorContract.anchorBatch(TRIP, root, 1000, 1999);

        // prove l2: sibling l3, then uncle pair(l0,l1)
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = l3;
        proof[1] = _pair(l0, l1);
        assertTrue(anchorContract.verifyPing(TRIP, 0, l2, proof));
    }

    function test_RejectTamperedLeaf() public {
        bytes32 l0 = keccak256("ping-0");
        bytes32 l1 = keccak256("ping-1");
        bytes32 root = _pair(l0, l1);

        vm.prank(anchorer);
        anchorContract.anchorBatch(TRIP, root, 1000, 1999);

        // attacker edits the ping (different leaf), reuses the honest proof
        bytes32 tampered = keccak256("ping-0-EDITED-LOCATION");
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = l1;
        assertFalse(anchorContract.verifyPing(TRIP, 0, tampered, proof));
    }

    function test_RejectWrongProof() public {
        bytes32 l0 = keccak256("ping-0");
        bytes32 l1 = keccak256("ping-1");
        bytes32 root = _pair(l0, l1);

        vm.prank(anchorer);
        anchorContract.anchorBatch(TRIP, root, 1000, 1999);

        bytes32[] memory badProof = new bytes32[](1);
        badProof[0] = keccak256("not-the-sibling");
        assertFalse(anchorContract.verifyPing(TRIP, 0, l0, badProof));
    }

    function test_RejectCrossBatchProof() public {
        // a leaf valid in batch 0 must not verify against batch 1's root
        bytes32 a0 = keccak256("a0");
        bytes32 a1 = keccak256("a1");
        bytes32 b0 = keccak256("b0");
        bytes32 b1 = keccak256("b1");

        vm.startPrank(anchorer);
        anchorContract.anchorBatch(TRIP, _pair(a0, a1), 1000, 1999);
        anchorContract.anchorBatch(TRIP, _pair(b0, b1), 2000, 2999);
        vm.stopPrank();

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = a1;
        assertTrue(anchorContract.verifyPing(TRIP, 0, a0, proof));
        assertFalse(anchorContract.verifyPing(TRIP, 1, a0, proof));
    }

    // ---------------------------------------------------------------- fuzz

    /// @dev Any 4 distinct random leaves: every leaf verifies under the root
    ///      with its honest proof; a random other value never does.
    function testFuzz_MerkleSoundness(bytes32 l0, bytes32 l1, bytes32 l2, bytes32 l3, bytes32 junk)
        public
    {
        vm.assume(l0 != l1 && l2 != l3 && l0 != l2 && l1 != l3 && l0 != l3 && l1 != l2);
        vm.assume(junk != l0 && junk != l1 && junk != l2 && junk != l3);
        // exclude the astronomically unlikely case junk equals an internal node path
        bytes32 root = _root4(l0, l1, l2, l3);
        vm.assume(junk != root);

        vm.prank(anchorer);
        anchorContract.anchorBatch(TRIP, root, 1000, 1999);

        bytes32[] memory p = new bytes32[](2);

        p[0] = l1; p[1] = _pair(l2, l3);
        assertTrue(anchorContract.verifyPing(TRIP, 0, l0, p));

        p[0] = l0; p[1] = _pair(l2, l3);
        assertTrue(anchorContract.verifyPing(TRIP, 0, l1, p));

        p[0] = l3; p[1] = _pair(l0, l1);
        assertTrue(anchorContract.verifyPing(TRIP, 0, l2, p));

        p[0] = l2; p[1] = _pair(l0, l1);
        assertTrue(anchorContract.verifyPing(TRIP, 0, l3, p));

        // junk leaf with an otherwise-honest proof must fail
        p[0] = l1; p[1] = _pair(l2, l3);
        assertFalse(anchorContract.verifyPing(TRIP, 0, junk, p));
    }

    /// @dev Batches must be strictly time-ordered for ANY random windows.
    function testFuzz_StrictTimeOrdering(uint64 from1, uint64 to1, uint64 from2, uint64 to2)
        public
    {
        from1 = uint64(bound(from1, 0, type(uint64).max - 2));
to1 = uint64(bound(to1, from1, type(uint64).max - 1));
        vm.prank(anchorer);
        anchorContract.anchorBatch(TRIP, keccak256("r0"), from1, to1);

        to2 = uint64(bound(to2, from2, type(uint64).max));
        vm.prank(anchorer);
        if (from2 <= to1) {
            vm.expectRevert(TripLogAnchor.TimeOverlap.selector);
            anchorContract.anchorBatch(TRIP, keccak256("r1"), from2, to2);
        } else {
            anchorContract.anchorBatch(TRIP, keccak256("r1"), from2, to2);
            assertEq(anchorContract.batchCount(TRIP), 2);
        }
    }
}