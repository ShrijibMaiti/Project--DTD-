import {
  BadRequestException, Injectable, NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { keccak256, toHex, type Hex, type Address } from "viem";
import { DatabaseService } from "../common/database.service";
import { AuditService } from "../common/audit.service";
import { BookingsService } from "../bookings/bookings.service";
import { CustodyService } from "../custody/custody.service";
import { GpsService } from "../gps/gps.service";
import { ManifestBuilder } from "@dtd/custody/manifest/builder";
import { PgManifestStore } from "@dtd/custody/db/manifest.store.pg";
import { DeviceRegistry } from "@dtd/gps/ingest/device-registry";
import { PgDeviceStore, PgDeviceAlertSink } from "@dtd/gps/db/device.store.pg";
import { CustodyStatus } from "@dtd/shared/manifest.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";
import { StartTripDto, ConfirmTripDeliveryDto } from "./orchestration.dto";

/**
 * ============================================================================
 * CROSS-DOMAIN ORCHESTRATION
 * ============================================================================
 *
 * WHY THIS IS ITS OWN MODULE
 * Threading cross-domain calls through domain services would make
 * BookingsModule and CustodyModule depend on each other — a genuine cycle,
 * survivable only with forwardRef(). forwardRef makes Nest tolerate a cycle;
 * it does not make the design acyclic, and it makes both modules harder to
 * test in isolation.
 *
 * Here the dependency runs one way: Orchestration -> {Bookings, Custody, GPS}.
 * No domain service imports another. The orchestrator owns the routes that
 * span domains; each domain keeps its own routes for single-domain work.
 *
 * THE FIVE DESIGN COMMITMENTS
 *
 * 1. ONE TRANSACTION, ONE CLIENT.
 *    Every write in startTrip() runs on a single PoolClient. Previously each
 *    service opened its own, so one request held three simultaneously —
 *    against `max: 20`, ~7 concurrent trip-starts would deadlock. It also
 *    buys real atomicity: a GPS failure now rolls back the assignment instead
 *    of leaving an assigned booking with no manifest.
 *
 * 2. DETERMINISTIC tripId.
 *    keccak256(bookingId), not keccak256(bookingId + Date.now()). Because
 *    ManifestBuilder anchors on-chain BEFORE persisting, a retry with a fresh
 *    tripId would anchor a SECOND manifest for the same booking. Deterministic
 *    derivation plus reuse-if-present makes retry non-corrupting.
 *
 * 3. THE REVERSE CHAIN FIRES FROM A WRITE.
 *    confirmDelivery() is the trigger, not a GET handler. A read-triggered
 *    transition would mean the booking only advances if somebody happens to
 *    poll a status endpoint — booking state as a function of who is looking
 *    at a dashboard.
 *
 * 4. NOTHING IS SKIPPED SILENTLY.
 *    Subscription gating and missing prerequisites produce explicit entries in
 *    the response, never a quietly incomplete success.
 *
 * 5. CHAIN WRITES GO LAST.
 *    Within the transaction: assign (DB) -> GPS bind (DB) -> manifest
 *    (DB + chain). The on-chain anchor is the one thing a rollback cannot
 *    undo, so it happens when nothing fallible remains after it.
 *
 * KNOWN LIMIT, STATED PLAINLY
 * If the transaction rolls back after ManifestBuilder anchored, the on-chain
 * manifest is orphaned — the chain has no rollback. A retry produces different
 * random piece IDs and therefore a different manifestId, so it anchors again
 * rather than colliding. Bounded (one orphan per failed attempt, no data
 * corruption, no double-spend) but real. Closing it needs an idempotency key
 * on manifest creation; tracked, not solved here.
 */

export type SkipReason =
  | "MODULE_NOT_ENABLED"
  | "PARTICIPANTS_NOT_SUPPLIED"
  | "DRIVER_HAS_NO_SIGNING_KEY"
  | "MANIFEST_ALREADY_EXISTS"
  | "NO_DEVICE_FOR_TRUCK"
  | "DEVICE_NOT_ACTIVE";

export interface StartTripResult {
  bookingId: string;
  tripId: string;
  assigned: true;
  truckId: string;
  driverId: string;
  custody: {
    created: boolean;
    manifestId: string | null;
    pieceCount: number | null;
    skipped: SkipReason | null;
    detail: string | null;
  };
  gps: {
    started: boolean;
    skipped: SkipReason | null;
    detail: string | null;
  };
}

export interface ConfirmDeliveryResult {
  bookingId: string;
  manifestId: string;
  delivery: {
    releasable: boolean;
    reason: string;
    scanned: number;
    expected: number;
    missing: number;
    chainStatus: CustodyStatus;
  };
  booking: { status: string; changed: boolean };
  gps: { ended: boolean; detail: string | null };
}

@Injectable()
export class OrchestrationService {
  constructor(
    private db: DatabaseService,
    private audit: AuditService,
    private bookings: BookingsService,
    private custody: CustodyService,
    private gps: GpsService
  ) {}

  // ==========================================================================
  // Forward chain
  // ==========================================================================

  async startTrip(params: {
    companyId: string;
    userId: string;
    bookingId: string;
    modules: PlatformModule[];
    dto: StartTripDto;
  }): Promise<StartTripResult> {
    const { companyId, userId, bookingId, modules, dto } = params;

    const custodyEnabled = modules.includes(PlatformModule.CUSTODY_TRACKING);
    const gpsEnabled = modules.includes(PlatformModule.GPS_TRACKING);

    const result = await this.db.withTenant(companyId, async (c) => {
      // ---- 0. tripId: deterministic, reused if the booking already has one.
      const tripId = await this.resolveTripId(c, bookingId);

      // ---- 1. Assignment. Mandatory — a failure here aborts everything.
      const booking = await this.bookings.assignTruck(
        companyId, userId, bookingId, dto, c
      );

      await this.bookings.linkTrip(companyId, bookingId, { tripId }, c);

      const out: StartTripResult = {
        bookingId,
        tripId,
        assigned: true,
        truckId: dto.truckId,
        driverId: dto.driverId,
        custody: {
          created: false, manifestId: null, pieceCount: null,
          skipped: null, detail: null,
        },
        gps: { started: false, skipped: null, detail: null },
      };

      // ---- 2. GPS binding (pure DB). Before custody so that a GPS problem
      //         cannot strand an on-chain anchor.
      if (!gpsEnabled) {
        out.gps.skipped = "MODULE_NOT_ENABLED";
        out.gps.detail = "GPS_TRACKING is not enabled on this plan.";
      } else {
        const registry = new DeviceRegistry(
          new PgDeviceStore(c, companyId),
          new PgDeviceAlertSink(c, companyId)
        );
        try {
          await registry.startTrip(dto.truckId, tripId);
          out.gps.started = true;
        } catch (err: any) {
          // A truck without a registered device is a normal operational
          // state, not an error — plenty of trucks have no tracker. Report
          // it and carry on. Anything else is unexpected and aborts.
          if (err.message?.startsWith("NO_DEVICE_FOR_TRUCK")) {
            out.gps.skipped = "NO_DEVICE_FOR_TRUCK";
            out.gps.detail =
              "No GPS device is registered against this truck. Register one " +
              "via POST /gps/devices to enable tracking for future trips.";
          } else if (err.message === "DEVICE_NOT_ACTIVE") {
            out.gps.skipped = "DEVICE_NOT_ACTIVE";
            out.gps.detail = "The truck's GPS device is suspended or retired.";
          } else {
            throw err;
          }
        }
      }

      // ---- 3. Custody manifest (DB + CHAIN). Last, deliberately.
      if (!custodyEnabled) {
        out.custody.skipped = "MODULE_NOT_ENABLED";
        out.custody.detail = "CUSTODY_TRACKING is not enabled on this plan.";
      } else if (!dto.loader || !dto.receiver) {
        out.custody.skipped = "PARTICIPANTS_NOT_SUPPLIED";
        out.custody.detail =
          "loader and receiver signing addresses are required to create a " +
          "manifest. They are obtained when each counterparty accepts their " +
          "co-sign link.";
      } else {
        const driverAddress = await this.driverSigningAddress(c, dto.driverId);
        if (!driverAddress) {
          out.custody.skipped = "DRIVER_HAS_NO_SIGNING_KEY";
          out.custody.detail =
            "This driver has no signing key. The driver must complete one OTP " +
            "verification to mint one — keys are never created on a driver's " +
            "behalf, because an unverified key cannot meaningfully sign.";
        } else {
          const manifests = new PgManifestStore(c, companyId);
          const existing = await manifests.getByBooking(bookingId);
          if (existing) {
            // Idempotency: a retried start-trip reuses the manifest that is
            // already anchored rather than anchoring a second one.
            out.custody.manifestId = existing.manifestId;
            out.custody.pieceCount = existing.pieceCount;
            out.custody.skipped = "MANIFEST_ALREADY_EXISTS";
            out.custody.detail = "Reusing the manifest already created for this booking.";
          } else {
            const manifest = await new ManifestBuilder(manifests).build({
              bookingId,
              transporterId: companyId,
              tripId: tripId as Hex,
              pieces: dto.pieces as any,
              pieceCount: dto.pieceCount,
              loader: dto.loader as Address,
              driver: driverAddress as Address,
              receiver: dto.receiver as Address,
            });
            out.custody.created = true;
            out.custody.manifestId = manifest.manifestId;
            out.custody.pieceCount = manifest.pieceCount;
            await this.bookings.linkTrip(
              companyId, bookingId, { manifestId: manifest.manifestId }, c
            );
          }
        }
      }

      await this.audit.record({
        companyId, userId,
        action: "TRIP_STARTED", entity: "booking", entityId: bookingId,
        detail: {
          tripId,
          truckId: dto.truckId,
          driverId: dto.driverId,
          manifestId: out.custody.manifestId,
          custodySkipped: out.custody.skipped,
          gpsStarted: out.gps.started,
          gpsSkipped: out.gps.skipped,
        },
      });

      void booking; // assignment already validated; hydrated row unused here
      return out;
    });

    return result;
  }

  // ==========================================================================
  // Reverse chain
  // ==========================================================================

  /**
   * The receiver signs for what actually arrived; the booking follows.
   *
   * This is a WRITE, and it is the only place the booking transitions to
   * DELIVERED. The three steps are sequential rather than atomic — the chain
   * write inside confirmDelivery() has already happened by the time the
   * booking updates — but each is idempotent, so a retry converges.
   */
  async confirmDelivery(params: {
    companyId: string;
    userId: string;
    bookingId: string;
    modules: PlatformModule[];
    dto: ConfirmTripDeliveryDto;
  }): Promise<ConfirmDeliveryResult> {
    const { companyId, userId, bookingId, modules, dto } = params;

    if (!modules.includes(PlatformModule.CUSTODY_TRACKING)) {
      throw new BadRequestException({
        error: "MODULE_NOT_ENABLED",
        message:
          "Confirming delivery requires CUSTODY_TRACKING. Without it there is " +
          "no manifest to sign against.",
      });
    }

    const row = await this.db.withTenant(companyId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, manifest_id, truck_id, status FROM bookings WHERE id = $1`,
        [bookingId]
      );
      return rows[0] ?? null;
    });
    if (!row) throw new NotFoundException();
    if (!row.manifest_id) {
      throw new BadRequestException({
        error: "NO_MANIFEST_FOR_BOOKING",
        message:
          "This booking has no custody manifest, so there is nothing to " +
          "confirm. Start the trip with loader and receiver addresses first.",
      });
    }

    // ---- 1. The custody write. Opens its own transactions by design: OTP
    //         consumption must commit independently so a failed delivery
    //         cannot leave a burned code replayable.
    const decision = await this.custody.confirmDelivery(
      companyId, userId, row.manifest_id, dto
    );

    // ---- 2. The booking transition. Delivered AND Short both close the
    //         trip — a short delivery is still a delivery, it just freezes
    //         payment. Only an unconfirmed or disputed manifest leaves the
    //         booking where it was.
    const closesTrip =
      decision.chainStatus === CustodyStatus.Delivered ||
      decision.chainStatus === CustodyStatus.Short;

    const bookingUpdate = closesTrip
      ? await this.bookings.markStatus(companyId, bookingId, "DELIVERED")
      : { id: bookingId, status: row.status, changed: false };

    // ---- 3. Release the GPS device binding. Best effort: a truck whose
    //         device stays bound is a nuisance, not a correctness problem,
    //         and it must not mask a successful delivery confirmation.
    const gpsOut: ConfirmDeliveryResult["gps"] = { ended: false, detail: null };
    if (closesTrip && row.truck_id) {
      try {
        await this.gps.endTrip(companyId, userId, row.truck_id);
        gpsOut.ended = true;
      } catch (err: any) {
        gpsOut.detail = `GPS unbind failed and was ignored: ${err.message}`;
      }
    }

    await this.audit.record({
      companyId, userId,
      action: "TRIP_DELIVERY_CONFIRMED", entity: "booking", entityId: bookingId,
      detail: {
        manifestId: row.manifest_id,
        releasable: decision.releasable,
        reason: decision.reason,
        scanned: decision.reconcile.scanned,
        missing: decision.reconcile.missing,
        bookingChanged: bookingUpdate.changed,
      },
    });

    return {
      bookingId,
      manifestId: row.manifest_id,
      delivery: {
        releasable: decision.releasable,
        reason: decision.reason,
        scanned: decision.reconcile.scanned,
        expected: decision.reconcile.expected,
        missing: decision.reconcile.missing,
        chainStatus: decision.chainStatus,
      },
      booking: { status: bookingUpdate.status, changed: bookingUpdate.changed },
      gps: gpsOut,
    };
  }

  // ==========================================================================
  // internals
  // ==========================================================================

  /**
   * Deterministic and stable: the same booking always yields the same tripId,
   * and an existing one is never replaced.
   *
   * Date.now() in the derivation would make every retry mint a new trip
   * identity. Since ManifestBuilder anchors before it persists, that would
   * anchor a second manifest for the same physical shipment — two on-chain
   * custody records, neither obviously wrong, for one truck.
   */
  private async resolveTripId(c: PoolClient, bookingId: string): Promise<string> {
    const { rows } = await c.query(
      `SELECT trip_id FROM bookings WHERE id = $1`, [bookingId]
    );
    if (!rows[0]) throw new NotFoundException();
    if (rows[0].trip_id) return rows[0].trip_id;
    return keccak256(toHex(`dtd-trip:${bookingId}`));
  }

  private async driverSigningAddress(
    c: PoolClient, driverId: string
  ): Promise<string | null> {
    const { rows } = await c.query(
      `SELECT signing_address FROM drivers WHERE id = $1`, [driverId]
    );
    return rows[0]?.signing_address ?? null;
  }
}
