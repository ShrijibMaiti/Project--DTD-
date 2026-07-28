// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/ReputationLedger.sol";

/// @notice Invariants under test:
///   1. An attestation exists ONLY with BOTH valid signatures over the exact
///      digest — wrong key, swapped roles, or flipped booleans all revert.
///   2. One attestation per trip, forever.
///   3. Aggregates never drift from the attestation history.
contract ReputationLedgerTest is Test {
    ReputationLedger ledger;

    uint256 driverPk = 0xD117E5;
    uint256 shipperPk = 0x5A1E5;
    uint256 strangerPk = 0xBAD;

    address driver;
    address shipper;
    address platform;

    bytes32 constant TRIP = keccak256("trip-001");

    function setUp() public {
        driver = vm.addr(driverPk);
        shipper = vm.addr(shipperPk);
        platform = makeAddr("platform");

        ledger = new ReputationLedger();
        ledger.setPlatform(platform, true);
    }

    // ---------------------------------------------------------------- helpers

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        bytes32 ethSigned = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethSigned);
        return abi.encodePacked(r, s, v);
    }

    function _attest(bytes32 tripId, bool onTime, bool disputeFree) internal {
        bytes32 d = ledger.attestationDigest(tripId, driver, shipper, onTime, disputeFree);
        vm.prank(platform);
        ledger.attest(
            tripId, driver, shipper, onTime, disputeFree,
            _sign(driverPk, d), _sign(shipperPk, d)
        );
    }

    // ---------------------------------------------------------------- access control

    function test_RevertWhen_NonPlatformAttests() public {
        bytes32 d = ledger.attestationDigest(TRIP, driver, shipper, true, true);
        vm.prank(makeAddr("rogue"));
        vm.expectRevert(ReputationLedger.NotPlatform.selector);
        ledger.attest(TRIP, driver, shipper, true, true, _sign(driverPk, d), _sign(shipperPk, d));
    }

    function test_RevertWhen_NonOwnerSetsPlatform() public {
        vm.prank(makeAddr("rogue"));
        vm.expectRevert(ReputationLedger.NotOwner.selector);
        ledger.setPlatform(makeAddr("rogue"), true);
    }

    // ---------------------------------------------------------------- dual-signature gate

    function test_AttestHappyPath() public {
        _attest(TRIP, true, true);

        ReputationLedger.Attestation memory a = ledger.getAttestation(TRIP);
        assertTrue(a.exists);
        assertEq(a.driver, driver);
        assertEq(a.shipper, shipper);
        assertTrue(a.onTime);
        assertTrue(a.disputeFree);
    }

    function test_RevertWhen_DriverSigForged() public {
        bytes32 d = ledger.attestationDigest(TRIP, driver, shipper, true, true);
        vm.prank(platform);
        vm.expectRevert(ReputationLedger.BadSignature.selector);
        ledger.attest(TRIP, driver, shipper, true, true,
            _sign(strangerPk, d),      // forged driver sig
            _sign(shipperPk, d));
    }

    function test_RevertWhen_ShipperSigForged() public {
        bytes32 d = ledger.attestationDigest(TRIP, driver, shipper, true, true);
        vm.prank(platform);
        vm.expectRevert(ReputationLedger.BadSignature.selector);
        ledger.attest(TRIP, driver, shipper, true, true,
            _sign(driverPk, d),
            _sign(strangerPk, d));     // forged shipper sig
    }

    function test_RevertWhen_SignaturesSwapped() public {
        // both signatures valid people — but in each other's slots
        bytes32 d = ledger.attestationDigest(TRIP, driver, shipper, true, true);
        vm.prank(platform);
        vm.expectRevert(ReputationLedger.BadSignature.selector);
        ledger.attest(TRIP, driver, shipper, true, true,
            _sign(shipperPk, d),
            _sign(driverPk, d));
    }

    function test_RevertWhen_BooleansFlippedAfterSigning() public {
        // parties signed {onTime: false} — platform tries to submit {onTime: true}.
        // The platform CANNOT launder a bad trip into a good one.
        bytes32 signedDigest = ledger.attestationDigest(TRIP, driver, shipper, false, true);
        bytes memory dSig = _sign(driverPk, signedDigest);
        bytes memory sSig = _sign(shipperPk, signedDigest);

        vm.prank(platform);
        vm.expectRevert(ReputationLedger.BadSignature.selector);
        ledger.attest(TRIP, driver, shipper, true, true, dSig, sSig);
    }

    function test_RevertWhen_ZeroAddresses() public {
        bytes32 d = ledger.attestationDigest(TRIP, address(0), shipper, true, true);
        vm.prank(platform);
        vm.expectRevert(ReputationLedger.ZeroAddress.selector);
        ledger.attest(TRIP, address(0), shipper, true, true, _sign(driverPk, d), _sign(shipperPk, d));
    }

    // ---------------------------------------------------------------- immutability

    function test_RevertWhen_DoubleAttest() public {
        _attest(TRIP, true, true);

        // no wipe, no upgrade, no "fix" — one attestation per trip forever
        bytes32 d = ledger.attestationDigest(TRIP, driver, shipper, false, false);
        vm.prank(platform);
        vm.expectRevert(ReputationLedger.AlreadyAttested.selector);
        ledger.attest(TRIP, driver, shipper, false, false, _sign(driverPk, d), _sign(shipperPk, d));
    }

    // ---------------------------------------------------------------- aggregates

    function test_AggregatesTrackHistory() public {
        _attest(keccak256("t1"), true, true);    // clean
        _attest(keccak256("t2"), false, true);   // late, no dispute
        _attest(keccak256("t3"), true, false);   // on time, disputed
        _attest(keccak256("t4"), false, false);  // bad trip

        ReputationLedger.Reputation memory r = ledger.getReputation(driver);
        assertEq(r.totalTrips, 4);
        assertEq(r.onTimeTrips, 2);
        assertEq(r.disputeFreeTrips, 2);
    }

    function test_FreshDriverIsZero() public {
        ReputationLedger.Reputation memory r = ledger.getReputation(makeAddr("newDriver"));
        assertEq(r.totalTrips, 0);
        assertEq(r.onTimeTrips, 0);
        assertEq(r.disputeFreeTrips, 0);
    }

    // ---------------------------------------------------------------- fuzz

    /// @dev For ANY sequence of up to 24 random trips, aggregates equal the
    ///      exact tallies of what was attested. Reputation can never drift.
    function testFuzz_AggregateIntegrity(uint24 flags) public {
        uint8 n = uint8(bound(uint256(flags) >> 16, 1, 24));
        uint32 expectOnTime;
        uint32 expectClean;

        for (uint256 i = 0; i < n; i++) {
            bool onTime = (flags >> i) & 1 == 1;
            bool clean = (flags >> (i + 1)) & 1 == 1;
            _attest(keccak256(abi.encodePacked("fuzz-trip", i)), onTime, clean);
            if (onTime) expectOnTime++;
            if (clean) expectClean++;
        }

        ReputationLedger.Reputation memory r = ledger.getReputation(driver);
        assertEq(r.totalTrips, n);
        assertEq(r.onTimeTrips, expectOnTime);
        assertEq(r.disputeFreeTrips, expectClean);
    }

    /// @dev ANY random key that is not the driver's key fails the driver slot.
    function testFuzz_OnlyDriverKeyPasses(uint248 rawPk) public {
        uint256 pk = bound(uint256(rawPk), 1, type(uint248).max);
        vm.assume(pk != driverPk);

        bytes32 d = ledger.attestationDigest(TRIP, driver, shipper, true, true);
        vm.prank(platform);
        vm.expectRevert(ReputationLedger.BadSignature.selector);
        ledger.attest(TRIP, driver, shipper, true, true, _sign(pk, d), _sign(shipperPk, d));
    }
}