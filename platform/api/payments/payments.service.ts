import {
  BadRequestException, Injectable, NotFoundException, UnauthorizedException,
} from "@nestjs/common";
import { createHmac, timingSafeEqual } from "crypto";
import { DatabaseService } from "../common/database.service";
import { AuditService } from "../common/audit.service";
import { CreateCollectionDto } from "./payments.dto";
import { isReleasable } from "@dtd/chain-sdk/verify";
import type { Hex } from "viem";

@Injectable()
export class PaymentsService {
  constructor(private db: DatabaseService, private audit: AuditService) {}

  async createCollection(transporterId: string, userId: string, dto: CreateCollectionDto) {
    return this.db.withTenant(transporterId, async (c) => {
      const booking = await c.query(`SELECT id, status FROM bookings WHERE id=$1`, [dto.bookingId]);
      if (!booking.rows[0]) throw new NotFoundException("BOOKING_NOT_FOUND");

      const dup = await c.query(
        `SELECT id FROM payments WHERE booking_id=$1 AND status IN ('PENDING','PAID')`,
        [dto.bookingId]
      );
      if (dup.rows[0]) throw new BadRequestException("PAYMENT_ALREADY_EXISTS");

      // In production: create a Razorpay order here and store gateway_order_id.
      const gatewayOrderId = `order_${dto.bookingId.replace(/-/g, "").slice(0, 14)}`;

      const { rows } = await c.query(
        `INSERT INTO payments
           (transporter_id, booking_id, amount_inr, method, status, gateway_order_id)
         VALUES ($1,$2,$3,$4,'PENDING',$5) RETURNING *`,
        [transporterId, dto.bookingId, dto.amountInr, dto.method, gatewayOrderId]
      );
      await this.audit.record({
        transporterId, userId,
        action: "COLLECTION_CREATED", entity: "payment", entityId: rows[0].id,
        detail: { amountInr: dto.amountInr, method: dto.method },
      });
      return rows[0];
    });
  }

  async getByBooking(transporterId: string, bookingId: string) {
    return this.db.withTenant(transporterId, async (c) => {
      const { rows } = await c.query(`SELECT * FROM payments WHERE booking_id=$1`, [bookingId]);
      if (!rows[0]) throw new NotFoundException();
      return rows[0];
    });
  }

  /** Razorpay-style webhook: HMAC-SHA256 of raw body with the webhook secret. */
  async handleGatewayWebhook(signature: string, body: any) {
    const expected = createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET!)
      .update(JSON.stringify(body))
      .digest("hex");
    

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException("BAD_WEBHOOK_SIGNATURE");
    }

    

    const event = body.event as string;
    const orderId = body.payload?.payment?.entity?.order_id as string;
    if (!orderId) throw new BadRequestException("NO_ORDER_ID");

    if (event === "payment.captured") {
      await this.db.asSystem(async (c) => {
        // Idempotent: only transition PENDING -> PAID once.
        await c.query(
          `UPDATE payments SET status='PAID', paid_at=now()
           WHERE gateway_order_id=$1 AND status='PENDING'`,
          [orderId]
        );
      });
    } else if (event === "payment.failed") {
      await this.db.asSystem((c) =>
        c.query(
          `UPDATE payments SET status='FAILED' WHERE gateway_order_id=$1 AND status='PENDING'`,
          [orderId]
        )
      );
    }
    return { ok: true };
  }

  /**
   * The INR mirror of Escrow.release(): payout to the fleet owner fires ONLY
   * after (a) internal signature checks out AND (b) the chain itself confirms
   * CustodyManifest.isReleasable(manifestId). Defense in depth — even a
   * compromised Domain 3 service cannot force a payout the chain disagrees with.
   */
  async handleReleaseGate(
    signature: string,
    body: { manifestId: string; bookingId: string; transporterId: string }
  ) {
    const expected = createHmac("sha256", process.env.DTD_INTERNAL_WEBHOOK_SECRET!)
      .update(JSON.stringify(body))
      .digest("hex");
    const a = Buffer.from(signature ?? "");
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException("BAD_INTERNAL_SIGNATURE");
    }

    const releasable = await isReleasable(body.manifestId as Hex);
    if (!releasable) {
      throw new BadRequestException("CHAIN_SAYS_NOT_RELEASABLE"); // 175/200 => frozen
    }

    await this.db.asSystem(async (c) => {
      await c.query(
        `UPDATE payments SET payout_status='RELEASED', payout_at=now()
         WHERE booking_id=$1 AND status='PAID' AND payout_status='HELD'`,
        [body.bookingId]
      );
    });
    await this.audit.record({
      transporterId: body.transporterId, userId: null,
      action: "PAYOUT_RELEASED", entity: "payment", entityId: body.bookingId,
      detail: { manifestId: body.manifestId },
    });
    return { ok: true, released: true };
  }
}