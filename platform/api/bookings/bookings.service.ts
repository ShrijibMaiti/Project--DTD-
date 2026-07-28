import {
  BadRequestException, Injectable, NotFoundException,
} from "@nestjs/common";
import { DatabaseService } from "../common/database.service";
import { AuditService } from "../common/audit.service";
import { PricingService } from "../pricing/pricing.service";
import { CreateBookingDto, AssignTruckDto } from "./bookings.dto";

/**
 * Lifecycle: QUOTED -> CONFIRMED -> ASSIGNED -> IN_TRANSIT -> DELIVERED
 *                                 \-> CANCELLED (free before truck at pickup)
 * IN_TRANSIT / DELIVERED transitions are driven by Domain 3 custody events,
 * not by this API — bookings only reflect them.
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

  async assignTruck(
    companyId: string, userId: string, id: string, dto: AssignTruckDto
  ) {
    return this.db.withTenant(companyId, async (c) => {
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

  /** Called by Domain 3 event handlers, not by HTTP. */
  async markStatus(companyId: string, id: string, status: "IN_TRANSIT" | "DELIVERED") {
    await this.db.withTenant(companyId, (c) =>
      c.query(`UPDATE bookings SET status=$2 WHERE id=$1`, [id, status])
    );
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