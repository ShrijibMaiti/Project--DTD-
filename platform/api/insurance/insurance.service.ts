import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../common/database.service";
import { AuditService } from "../common/audit.service";
import { BuyPolicyDto } from "./insurance.dto";

/**
 * Trip cover via partner API (ICICI-Lombard-style). PartnerClient is a stub —
 * swap in the real partner SDK behind the same interface. Premium floor ₹299.
 */
interface PartnerClient {
  createPolicy(input: {
    referenceId: string;
    declaredValueInr: number;
  }): Promise<{ policyNumber: string; premiumInr: number }>;
}

class StubPartnerClient implements PartnerClient {
  async createPolicy(input: { referenceId: string; declaredValueInr: number }) {
    const premium = Math.max(299, Math.round(input.declaredValueInr * 0.0009));
    return {
      policyNumber: `DTD-POL-${input.referenceId.slice(0, 8).toUpperCase()}`,
      premiumInr: premium,
    };
  }
}

@Injectable()
export class InsuranceService {
  private partner: PartnerClient = new StubPartnerClient();

  constructor(private db: DatabaseService, private audit: AuditService) {}

  async quote(transporterId: string, dto: BuyPolicyDto) {
    const premiumInr = Math.max(299, Math.round(dto.declaredValueInr * 0.0009));
    return { bookingId: dto.bookingId, declaredValueInr: dto.declaredValueInr, premiumInr };
  }

  async buy(transporterId: string, userId: string, dto: BuyPolicyDto) {
    return this.db.withTenant(transporterId, async (c) => {
      const booking = await c.query(
        `SELECT id, status FROM bookings WHERE id=$1`, [dto.bookingId]
      );
      if (!booking.rows[0]) throw new NotFoundException("BOOKING_NOT_FOUND");
      if (["DELIVERED", "CANCELLED"].includes(booking.rows[0].status)) {
        throw new BadRequestException("CANNOT_INSURE_FINISHED_BOOKING");
      }

      const existing = await c.query(
        `SELECT id FROM insurance_policies WHERE booking_id=$1`, [dto.bookingId]
      );
      if (existing.rows[0]) throw new BadRequestException("ALREADY_INSURED");

      const policy = await this.partner.createPolicy({
        referenceId: dto.bookingId,
        declaredValueInr: dto.declaredValueInr,
      });

      const { rows } = await c.query(
        `INSERT INTO insurance_policies
           (transporter_id, booking_id, policy_number, declared_value_inr, premium_inr, status)
         VALUES ($1,$2,$3,$4,$5,'ACTIVE') RETURNING *`,
        [transporterId, dto.bookingId, policy.policyNumber, dto.declaredValueInr, policy.premiumInr]
      );
      await this.audit.record({
        transporterId, userId,
        action: "POLICY_PURCHASED", entity: "insurance_policy", entityId: rows[0].id,
        detail: { policyNumber: policy.policyNumber },
      });
      return rows[0];
    });
  }

  async getPolicy(transporterId: string, bookingId: string) {
    return this.db.withTenant(transporterId, async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM insurance_policies WHERE booking_id=$1`, [bookingId]
      );
      if (!rows[0]) throw new NotFoundException();
      return rows[0];
    });
  }
}