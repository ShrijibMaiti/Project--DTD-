// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/CustodyManifest.sol";

/// @notice Invariant under test: NO custody handoff without both signatures, ever.
contract CustodyManifestTest is Test {
    CustodyManifest custody;

    uint256 loaderPk = 0xA11CE;
    uint256 driverPk = 0xB0B;
    uint256 receiverPk = 0xCA7;
    uint256 strangerPk = 0xBAD;

    address loader;
    address driver;
    address receiver;
    address platform = makeAddr("platform");

    bytes32 constant TRIP = keccak256("trip-001");
    bytes32 constant MANIFEST = keccak256("manifest-001");
    uint32 constant PIECES = 200;

    function setUp() public {
        loader = vm.addr(loaderPk);
        driver = vm.addr(driverPk);
        receiver = vm.addr(receiverPk);

        custody = new CustodyManifest();
        custody.setPlatform(platform, true);

        vm.prank(platform);
        custody.createManifest(MANIFEST, TRIP, PIECES, loader, driver, receiver);
    }

    // ---------------------------------------------------------------- helpers

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        bytes32 ethSigned = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethSigned);
        return abi.encodePacked(r, s, v);
    }

    function _bothSign() internal {
        bytes32 d = custody.loadingDigest(MANIFEST);
        vm.startPrank(platform);
        custody.submitLoaderSignature(MANIFEST, _sign(loaderPk, d));
        custody.submitDriverSignature(MANIFEST, _sign(driverPk, d));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- core invariant

    function test_NoCustodyWithOnlyLoaderSignature() public {
        bytes32 d = custody.loadingDigest(MANIFEST);
        vm.prank(platform);
        custody.submitLoaderSignature(MANIFEST, _sign(loaderPk, d));

        assertEq(
            uint8(custody.status(MANIFEST)),
            uint8(CustodyManifest.Status.Created),
            "custody must NOT start with one signature"
        );
    }

    function test_NoCustodyWithOnlyDriverSignature() public {
        bytes32 d = custody.loadingDigest(MANIFEST);
        vm.prank(platform);
        custody.submitDriverSignature(MANIFEST, _sign(driverPk, d));

        assertEq(
            uint8(custody.status(MANIFEST)),
            uint8(CustodyManifest.Status.Created)
        );
    }

    function test_CustodyStartsOnlyWhenBothSigned() public {
        _bothSign();
        assertEq(
            uint8(custody.status(MANIFEST)),
            uint8(CustodyManifest.Status.InCustody)
        );
    }

    function test_RevertWhen_WrongKeySignsAsLoader() public {
        bytes32 d = custody.loadingDigest(MANIFEST);
        bytes memory forged = _sign(strangerPk, d);

        vm.prank(platform);
        vm.expectRevert(CustodyManifest.BadSignature.selector);
        custody.submitLoaderSignature(MANIFEST, forged);
    }

    function test_RevertWhen_DriverKeySignsAsLoader() public {
        // even a VALID participant cannot sign someone else's slot
        bytes32 d = custody.loadingDigest(MANIFEST);
        bytes memory sig = _sign(driverPk, d);

        vm.prank(platform);
        vm.expectRevert(CustodyManifest.BadSignature.selector);
        custody.submitLoaderSignature(MANIFEST, sig);
    }

    function test_RevertWhen_NonPlatformRelays() public {
        bytes32 d = custody.loadingDigest(MANIFEST);
        bytes memory sig = _sign(loaderPk, d);

        vm.prank(address(0xDEAD));
        vm.expectRevert(CustodyManifest.NotPlatform.selector);
        custody.submitLoaderSignature(MANIFEST, sig);
    }

    // ---------------------------------------------------------------- delivery

    function test_ExactCountIsDelivered_AndReleasable() public {
        _bothSign();
        bytes32 d = custody.deliveryDigest(MANIFEST, PIECES);
        vm.prank(platform);
        custody.confirmDelivery(MANIFEST, PIECES, _sign(receiverPk, d));

        assertEq(uint8(custody.status(MANIFEST)), uint8(CustodyManifest.Status.Delivered));
        assertTrue(custody.isReleasable(MANIFEST));
    }

    function test_ShortCountIsShort_AndNotReleasable() public {
        _bothSign();
        uint32 shortCount = 175;
        bytes32 d = custody.deliveryDigest(MANIFEST, shortCount);
        vm.prank(platform);
        custody.confirmDelivery(MANIFEST, shortCount, _sign(receiverPk, d));

        assertEq(uint8(custody.status(MANIFEST)), uint8(CustodyManifest.Status.Short));
        assertFalse(custody.isReleasable(MANIFEST), "175/200 must freeze payment");
    }

    function test_RevertWhen_DeliveryBeforeCustody() public {
        // receiver cannot confirm delivery on an unsigned manifest
        bytes32 d = custody.deliveryDigest(MANIFEST, PIECES);
        vm.prank(platform);
        vm.expectRevert(CustodyManifest.WrongStatus.selector);
        custody.confirmDelivery(MANIFEST, PIECES, _sign(receiverPk, d));
    }

    function test_RevertWhen_SignatureCountMismatch() public {
        _bothSign();
        // receiver signed for 175 but platform relays 180 -> digest mismatch
        bytes32 d = custody.deliveryDigest(MANIFEST, 175);
        bytes memory sig = _sign(receiverPk, d);

        vm.prank(platform);
        vm.expectRevert(CustodyManifest.BadSignature.selector);
        custody.confirmDelivery(MANIFEST, 180, sig);
    }

    // ---------------------------------------------------------------- fuzz

    /// @dev For ANY random delivered count, releasable IFF count == PIECES.
    function testFuzz_ReleasableOnlyOnExactCount(uint32 delivered) public {
        delivered = uint32(bound(delivered, 0, PIECES));
        _bothSign();

        bytes32 d = custody.deliveryDigest(MANIFEST, delivered);
        vm.prank(platform);
        custody.confirmDelivery(MANIFEST, delivered, _sign(receiverPk, d));

        assertEq(custody.isReleasable(MANIFEST), delivered == PIECES);
    }

    /// @dev For ANY random private key that isn't the loader's, signing fails.
    function testFuzz_OnlyLoaderKeyPassesLoaderSlot(uint248 rawPk) public {
        uint256 pk = bound(uint256(rawPk), 1, type(uint248).max);
        vm.assume(pk != loaderPk);

        bytes32 d = custody.loadingDigest(MANIFEST);
        bytes memory sig = _sign(pk, d);

        vm.prank(platform);
        vm.expectRevert(CustodyManifest.BadSignature.selector);
        custody.submitLoaderSignature(MANIFEST, sig);
    }
}