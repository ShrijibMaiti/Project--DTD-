// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/CustodyManifest.sol";
import "../contracts/Escrow.sol";
import "../contracts/DocumentRegistry.sol";
import "../contracts/ReputationLedger.sol";

/// @dev A payee that cannot receive ETH — forces the TransferFailed branches.
contract EthRejector {
    // no receive(), no fallback: any value transfer to this contract reverts
}

/// @notice Gap-closure suite: admin paths, guard reverts, dispute lifecycle,
///         malformed signatures, and failed-transfer branches across all
///         four remaining contracts.
contract CoverageGapsTest is Test {
    CustodyManifest custody;
    Escrow escrow;
    DocumentRegistry registry;
    ReputationLedger ledger;

    uint256 loaderPk = 0xA11CE;
    uint256 driverPk = 0xB0B;
    uint256 receiverPk = 0xCA7;

    address loader;
    address driver;
    address receiver;
    address platform;
    address arbiter;
    address payer;

    bytes32 constant TRIP = keccak256("trip-001");
    bytes32 constant MANIFEST = keccak256("manifest-001");
    uint32 constant PIECES = 200;

    function setUp() public {
        loader = vm.addr(loaderPk);
        driver = vm.addr(driverPk);
        receiver = vm.addr(receiverPk);
        platform = makeAddr("platform");
        arbiter = makeAddr("arbiter");
        payer = makeAddr("payer");

        custody = new CustodyManifest();
        custody.setPlatform(platform, true);
        escrow = new Escrow(address(custody), arbiter);
        registry = new DocumentRegistry();
        ledger = new ReputationLedger();

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

    // ================================================================
    // CustodyManifest — admin, guards, dispute, malformed signatures
    // ================================================================

    function test_Custody_TransferOwnership() public {
        address newOwner = makeAddr("newOwner");
        custody.transferOwnership(newOwner);
        assertEq(custody.owner(), newOwner);
        vm.expectRevert(CustodyManifest.NotOwner.selector);
        custody.setPlatform(makeAddr("x"), true);
    }

    function test_Custody_RevertWhen_NonOwnerSetsPlatform() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert(CustodyManifest.NotOwner.selector);
        custody.setPlatform(makeAddr("rogue"), true);
    }

    function test_Custody_RevertWhen_DuplicateManifest() public {
        vm.prank(platform);
        vm.expectRevert(CustodyManifest.AlreadyExists.selector);
        custody.createManifest(MANIFEST, TRIP, PIECES, loader, driver, receiver);
    }

    function test_Custody_RevertWhen_ZeroPieceCount() public {
        vm.prank(platform);
        vm.expectRevert(CustodyManifest.ZeroCount.selector);
        custody.createManifest(keccak256("m2"), TRIP, 0, loader, driver, receiver);
    }

    function test_Custody_RevertWhen_ZeroParticipant() public {
        vm.startPrank(platform);
        vm.expectRevert(CustodyManifest.ZeroAddress.selector);
        custody.createManifest(keccak256("m3"), TRIP, PIECES, address(0), driver, receiver);
        vm.expectRevert(CustodyManifest.ZeroAddress.selector);
        custody.createManifest(keccak256("m4"), TRIP, PIECES, loader, address(0), receiver);
        vm.expectRevert(CustodyManifest.ZeroAddress.selector);
        custody.createManifest(keccak256("m5"), TRIP, PIECES, loader, driver, address(0));
        vm.stopPrank();
    }

    function test_Custody_RevertWhen_NonPlatformCreates() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert(CustodyManifest.NotPlatform.selector);
        custody.createManifest(keccak256("m6"), TRIP, PIECES, loader, driver, receiver);
    }

    function test_Custody_RevertWhen_DeliveredExceedsManifest() public {
        _startCustody();
        bytes32 d = custody.deliveryDigest(MANIFEST, PIECES + 1);
        vm.prank(platform);
        vm.expectRevert(CustodyManifest.CountExceedsManifest.selector);
        custody.confirmDelivery(MANIFEST, PIECES + 1, _sign(receiverPk, d));
    }

    function test_Custody_RevertWhen_SigWrongLength() public {
        vm.prank(platform);
        vm.expectRevert(CustodyManifest.BadSignature.selector);
        custody.submitLoaderSignature(MANIFEST, hex"deadbeef"); // 4 bytes, not 65
    }

    function test_Custody_RevertWhen_SigInvalidV() public {
        // valid r,s but nonsense v -> ecrecover returns address(0) -> BadSignature
        bytes32 d = custody.loadingDigest(MANIFEST);
        bytes memory good = _sign(loaderPk, d);
        bytes memory bad = new bytes(65);
        for (uint256 i = 0; i < 64; i++) bad[i] = good[i];
        bad[64] = bytes1(uint8(2)); // v=2 -> +27 = 29 -> invalid

        vm.prank(platform);
        vm.expectRevert(CustodyManifest.BadSignature.selector);
        custody.submitLoaderSignature(MANIFEST, bad);
    }

    function test_Custody_MarkDisputed_Lifecycle() public {
        _startCustody();
        vm.prank(platform);
        custody.markDisputed(MANIFEST);

        assertEq(uint8(custody.status(MANIFEST)), uint8(CustodyManifest.Status.Disputed));
        assertFalse(custody.isReleasable(MANIFEST));

        // disputed manifests accept no further delivery confirmations
        bytes32 d = custody.deliveryDigest(MANIFEST, PIECES);
        vm.prank(platform);
        vm.expectRevert(CustodyManifest.WrongStatus.selector);
        custody.confirmDelivery(MANIFEST, PIECES, _sign(receiverPk, d));
    }

    function test_Custody_RevertWhen_DisputingNonexistent() public {
        vm.prank(platform);
        vm.expectRevert(CustodyManifest.DoesNotExist.selector);
        custody.markDisputed(keccak256("ghost"));
    }

    function test_Custody_GetManifestFields() public {
        CustodyManifest.Manifest memory m = custody.getManifest(MANIFEST);
        assertEq(m.tripId, TRIP);
        assertEq(m.pieceCount, PIECES);
        assertEq(m.loader, loader);
        assertEq(m.driver, driver);
        assertEq(m.receiver, receiver);
        assertEq(uint8(m.status), uint8(CustodyManifest.Status.Created));
    }

    // ================================================================
    // Escrow — admin, guards, disputed-status route, transfer failures
    // ================================================================

    function test_Escrow_RevertWhen_ConstructorZeroAddress() public {
        vm.expectRevert(Escrow.ZeroAddress.selector);
        new Escrow(address(0), arbiter);
        vm.expectRevert(Escrow.ZeroAddress.selector);
        new Escrow(address(custody), address(0));
    }

    function test_Escrow_TransferOwnership() public {
        address newOwner = makeAddr("escrowOwner");
        escrow.transferOwnership(newOwner);
        assertEq(escrow.owner(), newOwner);
        vm.expectRevert(Escrow.NotOwner.selector);
        escrow.setArbiter(makeAddr("x"));
    }

    function test_Escrow_SetArbiter() public {
        address a2 = makeAddr("arbiter2");
        escrow.setArbiter(a2);
        assertEq(escrow.arbiter(), a2);
    }

    function test_Escrow_RevertWhen_SetArbiterZero() public {
        vm.expectRevert(Escrow.ZeroAddress.selector);
        escrow.setArbiter(address(0));
    }

    function test_Escrow_RevertWhen_NonOwnerSetsArbiter() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert(Escrow.NotOwner.selector);
        escrow.setArbiter(makeAddr("rogue"));
    }

    function test_Escrow_RevertWhen_FundZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(Escrow.ZeroAmount.selector);
        escrow.fund{value: 0}(MANIFEST, driver);
    }

    function test_Escrow_RevertWhen_FundZeroPayee() public {
        vm.prank(payer);
        vm.expectRevert(Escrow.ZeroAddress.selector);
        escrow.fund{value: 1 ether}(MANIFEST, address(0));
    }

    function test_Escrow_GetDeposit() public {
        vm.prank(payer);
        escrow.fund{value: 3 ether}(MANIFEST, driver);

        Escrow.Deposit memory dep = escrow.getDeposit(MANIFEST);
        assertEq(dep.payer, payer);
        assertEq(dep.payee, driver);
        assertEq(dep.amount, 3 ether);
        assertEq(uint8(dep.status), uint8(Escrow.DepositStatus.Funded));
    }

    function test_Escrow_RevertWhen_ReleaseUnfunded() public {
        vm.expectRevert(Escrow.NotFunded.selector);
        escrow.release(keccak256("never-funded"));
    }

    function test_Escrow_RevertWhen_ResolveUnfunded() public {
        vm.prank(arbiter);
        vm.expectRevert(Escrow.NotFunded.selector);
        escrow.resolveDispute(keccak256("never-funded"), 0);
    }

    function test_Escrow_RevertWhen_SplitExceedsDeposit() public {
        vm.prank(payer);
        escrow.fund{value: 2 ether}(MANIFEST, driver);
        _startCustody();
        _deliver(175);

        vm.prank(arbiter);
        vm.expectRevert(Escrow.ZeroAmount.selector);
        escrow.resolveDispute(MANIFEST, 3 ether);
    }

    function test_Escrow_ResolveViaDisputedStatus() public {
        // the STATUS_DISPUTED route (previous suites only exercised Short)
        vm.prank(payer);
        escrow.fund{value: 4 ether}(MANIFEST, driver);
        _startCustody();
        vm.prank(platform);
        custody.markDisputed(MANIFEST);

        uint256 payeeBefore = driver.balance;
        uint256 payerBefore = payer.balance;
        vm.prank(arbiter);
        escrow.resolveDispute(MANIFEST, 1 ether);

        assertEq(driver.balance - payeeBefore, 1 ether);
        assertEq(payer.balance - payerBefore, 3 ether);
    }

    function test_Escrow_ResolveFullToPayee_SkipsPayerBranch() public {
        vm.prank(payer);
        escrow.fund{value: 2 ether}(MANIFEST, driver);
        _startCustody();
        _deliver(175);

        uint256 before = driver.balance;
        vm.prank(arbiter);
        escrow.resolveDispute(MANIFEST, 2 ether); // toPayer == 0 branch
        assertEq(driver.balance - before, 2 ether);
        assertEq(address(escrow).balance, 0);
    }

    function test_Escrow_ResolveFullToPayer_SkipsPayeeBranch() public {
        vm.prank(payer);
        escrow.fund{value: 2 ether}(MANIFEST, driver);
        _startCustody();
        _deliver(175);

        uint256 before = payer.balance;
        vm.prank(arbiter);
        escrow.resolveDispute(MANIFEST, 0); // splitToPayee == 0 branch
        assertEq(payer.balance - before, 2 ether);
    }

    function test_Escrow_RevertWhen_ReleaseTransferFails() public {
        EthRejector rejector = new EthRejector();
        vm.prank(payer);
        escrow.fund{value: 1 ether}(MANIFEST, address(rejector));
        _startCustody();
        _deliver(PIECES); // fully releasable — but payee refuses ETH

        vm.expectRevert(Escrow.TransferFailed.selector);
        escrow.release(MANIFEST);
    }

    function test_Escrow_RevertWhen_DisputeTransferFails() public {
        EthRejector rejector = new EthRejector();
        vm.prank(payer);
        escrow.fund{value: 1 ether}(MANIFEST, address(rejector));
        _startCustody();
        _deliver(175);

        vm.prank(arbiter);
        vm.expectRevert(Escrow.TransferFailed.selector);
        escrow.resolveDispute(MANIFEST, 0.5 ether);
    }

    // ================================================================
    // DocumentRegistry + ReputationLedger — remaining admin/sig branches
    // ================================================================

    function test_Registry_TransferOwnership() public {
        address newOwner = makeAddr("regOwner");
        registry.transferOwnership(newOwner);
        assertEq(registry.owner(), newOwner);
        vm.expectRevert(DocumentRegistry.NotOwner.selector);
        registry.setRegistrar(makeAddr("x"), true);
    }

    function test_Ledger_TransferOwnership() public {
        address newOwner = makeAddr("ledgerOwner");
        ledger.transferOwnership(newOwner);
        assertEq(ledger.owner(), newOwner);
        vm.expectRevert(ReputationLedger.NotOwner.selector);
        ledger.setPlatform(makeAddr("x"), true);
    }

    function test_Ledger_RevertWhen_SigWrongLength() public {
        ledger.setPlatform(platform, true);
        bytes32 d = ledger.attestationDigest(TRIP, driver, loader, true, true);
        vm.prank(platform);
        vm.expectRevert(ReputationLedger.BadSignature.selector);
        ledger.attest(TRIP, driver, loader, true, true, hex"beef", _sign(loaderPk, d));
    }

    function test_Ledger_RevertWhen_SigInvalidV() public {
        ledger.setPlatform(platform, true);
        bytes32 d = ledger.attestationDigest(TRIP, driver, loader, true, true);
        bytes memory good = _sign(driverPk, d);
        bytes memory bad = new bytes(65);
        for (uint256 i = 0; i < 64; i++) bad[i] = good[i];
        bad[64] = bytes1(uint8(2));

        vm.prank(platform);
        vm.expectRevert(ReputationLedger.BadSignature.selector);
        ledger.attest(TRIP, driver, loader, true, true, bad, _sign(loaderPk, d));
    }
}