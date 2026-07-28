// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/CustodyManifest.sol";
import "../contracts/Escrow.sol";

/// @notice Invariant under test: money moves ONLY through the release
///         conditions. Full scan match -> payee. Short/Disputed -> arbiter
///         split. Nothing else, ever.
contract EscrowTest is Test {
    CustodyManifest custody;
    Escrow escrow;

    uint256 loaderPk = 0xA11CE;
    uint256 driverPk = 0xB0B;
    uint256 receiverPk = 0xCA7;

    address loader;
    address driver;
    address receiver;
    address platform = makeAddr("platform");
    address arbiter = address(0xA5b1);
    address payer = address(0xFA9e5);
    address payee; // fleet owner — use driver addr for simplicity

    bytes32 constant TRIP = keccak256("trip-001");
    bytes32 constant MANIFEST = keccak256("manifest-001");
    uint32 constant PIECES = 200;

    function setUp() public {
        loader = vm.addr(loaderPk);
        driver = vm.addr(driverPk);
        receiver = vm.addr(receiverPk);
        payee = driver;

        custody = new CustodyManifest();
        custody.setPlatform(platform, true);
        escrow = new Escrow(address(custody), arbiter);

        vm.prank(platform);
        custody.createManifest(MANIFEST, TRIP, PIECES, loader, driver, receiver);

        vm.deal(payer, 100 ether);
    }

    // ---------------------------------------------------------------- helpers

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        bytes32 ethSigned = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethSigned);
        return abi.encodePacked(r, s, v);
    }

    function _startCustody() internal {
        bytes32 d = custody.loadingDigest(MANIFEST);
        vm.startPrank(platform);
        custody.submitLoaderSignature(MANIFEST, _sign(loaderPk, d));
        custody.submitDriverSignature(MANIFEST, _sign(driverPk, d));
        vm.stopPrank();
    }

    function _deliver(uint32 count) internal {
        bytes32 d = custody.deliveryDigest(MANIFEST, count);
        vm.prank(platform);
        custody.confirmDelivery(MANIFEST, count, _sign(receiverPk, d));
    }

    function _fund(uint256 amount) internal {
        vm.prank(payer);
        escrow.fund{value: amount}(MANIFEST, payee);
    }

    // ---------------------------------------------------------------- happy path

    function test_ReleaseAfterFullScanMatch() public {
        _fund(10 ether);
        _startCustody();
        _deliver(PIECES); // 200/200

        uint256 before = payee.balance;
        escrow.release(MANIFEST); // callable by anyone — condition is the gate
        assertEq(payee.balance - before, 10 ether);
    }

    // ---------------------------------------------------------------- the gate

    function test_RevertWhen_ReleaseBeforeDelivery() public {
        _fund(10 ether);
        _startCustody();

        vm.expectRevert(Escrow.NotReleasable.selector);
        escrow.release(MANIFEST);
    }

    function test_RevertWhen_ReleaseOnShortDelivery() public {
        _fund(10 ether);
        _startCustody();
        _deliver(175); // 175/200 — the missing-25 scenario

        vm.expectRevert(Escrow.NotReleasable.selector);
        escrow.release(MANIFEST); // no scan match -> no money
    }

    function test_RevertWhen_DoubleRelease() public {
        _fund(10 ether);
        _startCustody();
        _deliver(PIECES);

        escrow.release(MANIFEST);
        vm.expectRevert(Escrow.NotFunded.selector);
        escrow.release(MANIFEST);
    }

    function test_RevertWhen_DoubleFund() public {
        _fund(1 ether);
        vm.prank(payer);
        vm.expectRevert(Escrow.AlreadyFunded.selector);
        escrow.fund{value: 1 ether}(MANIFEST, payee);
    }

    // ---------------------------------------------------------------- disputes

    function test_ArbiterSplitsShortDelivery() public {
        _fund(10 ether);
        _startCustody();
        _deliver(175);

        uint256 payeeBefore = payee.balance;
        uint256 payerBefore = payer.balance;

        // freight for 175 delivered pieces: 8.75 ether to payee, rest back
        vm.prank(arbiter);
        escrow.resolveDispute(MANIFEST, 8.75 ether);

        assertEq(payee.balance - payeeBefore, 8.75 ether);
        assertEq(payer.balance - payerBefore, 1.25 ether);
    }

    function test_RevertWhen_NonArbiterResolves() public {
        _fund(10 ether);
        _startCustody();
        _deliver(175);

        vm.prank(address(0xDEAD));
        vm.expectRevert(Escrow.NotArbiter.selector);
        escrow.resolveDispute(MANIFEST, 5 ether);
    }

    function test_RevertWhen_ResolvingCleanDelivery() public {
        _fund(10 ether);
        _startCustody();
        _deliver(PIECES); // clean — arbiter has no business here

        vm.prank(arbiter);
        vm.expectRevert(Escrow.NotDisputeState.selector);
        escrow.resolveDispute(MANIFEST, 5 ether);
    }

    // ---------------------------------------------------------------- fuzz

    /// @dev ANY amount, ANY delivered count: funds leave escrow to payee
    ///      via release() ONLY when count == PIECES.
    function testFuzz_MoneyGate(uint96 amount, uint32 delivered) public {
        amount = uint96(bound(amount, 1, 50 ether));
        delivered = uint32(bound(delivered, 0, PIECES));

        vm.deal(payer, amount);
        _fund(amount);
        _startCustody();
        _deliver(delivered);

        if (delivered == PIECES) {
            uint256 before = payee.balance;
            escrow.release(MANIFEST);
            assertEq(payee.balance - before, amount);
        } else {
            vm.expectRevert(Escrow.NotReleasable.selector);
            escrow.release(MANIFEST);
        }
    }

    /// @dev Conservation of money: arbiter split NEVER creates or destroys funds.
    function testFuzz_DisputeSplitConserved(uint96 amount, uint96 split) public {
        amount = uint96(bound(amount, 1, 50 ether));
        split = uint96(bound(split, 0, amount));

        vm.deal(payer, amount);
        _fund(amount);
        _startCustody();
        _deliver(175);

        uint256 payeeBefore = payee.balance;
        uint256 payerBefore = payer.balance;

        vm.prank(arbiter);
        escrow.resolveDispute(MANIFEST, split);

        assertEq(
            (payee.balance - payeeBefore) + (payer.balance - payerBefore),
            uint256(amount),
            "split must conserve total"
        );
        assertEq(address(escrow).balance, 0, "escrow must be empty after resolution");
    }
}