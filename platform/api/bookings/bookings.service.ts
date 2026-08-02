import {
  BadRequestException, Injectable, NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../common/database.service";
import { AuditService } from "../common/audit.service";
import { PricingService } from "../pricing/pricing.service";
import { CreateBookingDto, AssignTruckDto } from "./bookings.dto";

/**
 * Lifecycle: QUOTED -> CONFIRMED -> ASSIGNED -> IN_TRANSIT -> DELIVERED
 *                                 \-> CANCELLED (free before truck at pickup)
 *
 * IN_TRANSIT / DELIVERED transitions are driven by custody events via
 * OrchestrationService — bookings only reflect them. Note this service does
 * NOT import CustodyService: the dependency runs one way only, orchestration
 * -> domains, which is what keeps the module graph acyclic.
 *
 * PHASE B: assignTruck() and markStatus() accept an optional PoolClient so
 * they can participate in an orchestrated transaction rather than opening
 * their own. Existing callers pass nothing and behave exactly as before.
 */
@Injectable()
export class BookingsService {
  constructor(
    private db: DatabaseService,
    private audit: AuditService,
    private pricing: PricingService
  ) {}

  async create(companyId: string, userId: string, dto: CreateBookingDto) {
    const quote = await this.pricing.getQuote(companyId, dto.quoteId);
    if (!quote) throw new BadRequestException("QUOTE_NOT_FOUND_OR_EXPIRED");

    const pickups = dto.stops.filter((s) => s.kind === "PICKUP").length;
    const drops = dto.stops.filter((s) => s.kind === "DROP").length;
    if (pickups < 1 || drops < 1) {
      throw new BadRequestException("NEED_AT_LEAST_ONE_PICKUP_AND_ONE_DROP");
    }
    if (new Date(dto.scheduledAt).getTime() < Date.now()) {
      throw new BadRequestException("SCHEDULED_AT_MUST_BE_FUTURE");
    }

    return this.db.withTenant(companyId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO bookings
           (company_id, quote_id, truck_type, material_weight_kg,
            scheduled_at, status, estimated_price_inr, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,'CONFIRMED',$6,$7,$8)
         RETURNING *`,
        [
          companyId, dto.quoteId, dto.truckType, dto.materialWeightKg,
          dto.scheduledAt, quote.estimated_price_inr, dto.notes ?? null, userId,
        ]
      );
      const booking = rows[0];

      for (const s of dto.stops) {
        await c.query(
          `INSERT INTO booking_stops (booking_id, kind, address, lat, lng, sequence)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [booking.id, s.kind, s.address, s.lat, s.lng, s.sequence]
        );
      }

      await this.audit.record({
        companyId, userId,
        action: "BOOKING_CREATED", entity: "booking", entityId: booking.id,
      });
      return this.hydrate(c, booking);
    });
  }

  async get(companyId: string, id: string) {
    return this.db.withTenant(companyId, async (c) => {
      const { rows } = await c.query(`SELECT * FROM bookings WHERE id = $1`, [id]);
      if (!rows[0]) throw new NotFoundException();
      return this.hydrate(c, rows[0]);
    });
  }

  async list(companyId: string) {
    return this.db.withTenant(companyId, async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM bookings ORDER BY created_at DESC LIMIT 100`
      );
      return rows;
    });
  }

  /**
   * @param client optional — when supplied, joins the caller's transaction so
   *               assignment, GPS binding and manifest creation commit or roll
   *               back as one unit. See DatabaseService.withTenantOn.
   */
  async assignTruck(
    companyId: string, userId: string, id: string, dto: AssignTruckDto,
    client?: PoolClient
  ) {
    return this.db.withTenantOn(companyId, client, async (c) => {
      const { rows } = await c.query(
        `SELECT status FROM bookings WHERE id = $1 FOR UPDATE`, [id]
      );
      if (!rows[0]) throw new NotFoundException();
      if (rows[0].status !== "CONFIRMED") {
        throw new BadRequestException("ONLY_CONFIRMED_BOOKINGS_CAN_BE_ASSIGNED");
      }

      const truck = await c.query(
        `SELECT id FROM trucks WHERE id = $1 AND status = 'AVAILABLE'`, [dto.truckId]
      );
      if (!truck.rows[0]) throw new BadRequestException("TRUCK_NOT_AVAILABLE");

      const driver = await c.query(
        `SELECT id FROM drivers WHERE id = $1 AND status = 'ACTIVE'`, [dto.driverId]
      );
      if (!driver.rows[0]) throw new BadRequestException("DRIVER_NOT_ACTIVE");

      await c.query(
        `UPDATE bookings SET status='ASSIGNED', truck_id=$2, driver_id=$3,
                assigned_at=now() WHERE id=$1`,
        [id, dto.truckId, dto.driverId]
      );
      await c.query(
        `UPDATE trucks SET status='ON_TRIP' WHERE id=$1`, [dto.truckId]
      );

      await this.audit.record({
        companyId, userId,
        action: "BOOKING_ASSIGNED", entity: "booking", entityId: id,
        detail: { truckId: dto.truckId, driverId: dto.driverId },
      });
      const updated = await c.query(`SELECT * FROM bookings WHERE id=$1`, [id]);
      return this.hydrate(c, updated.rows[0]);
    });
  }

  /** Free cancellation only before the truck reaches pickup (i.e. pre-transit). */
  async cancel(companyId: string, userId: string, id: string, reason?: string) {
    return this.db.withTenant(companyId, async (c) => {
      const { rows } = await c.query(
        `SELECT status, truck_id FROM bookings WHERE id=$1 FOR UPDATE`, [id]
      );
      if (!rows[0]) throw new NotFoundException();
      if (!["CONFIRMED", "ASSIGNED"].includes(rows[0].status)) {
        throw new BadRequestException("CANNOT_CANCEL_AFTER_TRANSIT_STARTS");
      }

      await c.query(
        `UPDATE bookings SET status='CANCELLED', cancel_reason=$2, cancelled_at=now()
         WHERE id=$1`,
        [id, reason ?? null]
      );
      if (rows[0].truck_id) {
        await c.query(`UPDATE trucks SET status='AVAILABLE' WHERE id=$1`, [rows[0].truck_id]);
      }

      await this.audit.record({
        companyId, userId,
        action: "BOOKING_CANCELLED", entity: "booking", entityId: id,
        detail: { reason },
      });
      return { id, status: "CANCELLED" };
    });
  }

  /**
   * Reflects a custody event. Called by OrchestrationService from the
   * confirm-delivery WRITE path — never from a GET handler, so the transition
   * happens exactly once, at the moment delivery becomes final, rather than
   * whenever somebody happens to poll a dashboard.
   *
   * Idempotent by design: re-running it is a no-op, which matters because the
   * custody chain write that precedes it is not transactional with this update.
   */
  async markStatus(
    companyId: string, id: string, status: "IN_TRANSIT" | "DELIVERED",
    client?: PoolClient
  ) {
    return this.db.withTenantOn(companyId, client, async (c) => {
      const { rows } = await c.query(
        `UPDATE bookings SET status=$2
         WHERE id=$1 AND status IS DISTINCT FROM $2
         RETURNING id, status`,
        [id, status]
      );
      return { id, status, changed: rows.length > 0 };
    });
  }

  /** PHASE B: records the identifiers owned by custody and GPS. */
  async linkTrip(
    companyId: string, id: string,
    fields: { tripId?: string; manifestId?: string },
    client?: PoolClient
  ) {
    return this.db.withTenantOn(companyId, client, async (c) => {
      await c.query(
        `UPDATE bookings
         SET trip_id = COALESCE($2, trip_id),
             manifest_id = COALESCE($3, manifest_id)
         WHERE id = $1`,
        [id, fields.tripId ?? null, fields.manifestId ?? null]
      );
    });
  }

  private async hydrate(c: any, booking: any) {
    const stops = await c.query(
      `SELECT kind, address, lat, lng, sequence FROM booking_stops
       WHERE booking_id=$1 ORDER BY sequence`,
      [booking.id]
    );
    return { ...booking, stops: stops.rows };
  }
}
