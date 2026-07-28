import { BadRequestException, Injectable } from "@nestjs/common";
import { DatabaseService } from "../common/database.service";
import { EstimateDto } from "./pricing.dto";

/** Base rates per km by truck type — tune from real market data over time. */
const RATE_PER_KM: Record<string, number> = {
  PICKUP_TRUCK: 18,
  OPEN_14FT: 28,
  OPEN_22FT: 38,
  CONTAINER_20FT: 42,
  CONTAINER_32FT_SXL: 55,
  CONTAINER_32FT_MXL: 62,
};

const QUOTE_TTL_MINUTES = 30;

@Injectable()
export class PricingService {
  constructor(private db: DatabaseService) {}

  async estimate(companyId: string, dto: EstimateDto) {
    const rate = RATE_PER_KM[dto.truckType];
    if (!rate) throw new BadRequestException("UNKNOWN_TRUCK_TYPE");

    const km = this.haversineKm(
      dto.pickupLat, dto.pickupLng, dto.dropLat, dto.dropLng
    );
    // Road distance ≈ 1.25 × great-circle; weight surcharge above 80% capacity.
    const roadKm = Math.max(km * 1.25, 5);
    const base = roadKm * rate;
    const estimated = Math.round(base);
    const low = Math.round(base * 0.9);
    const high = Math.round(base * 1.15);

    return this.db.withTenant(companyId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO price_quotes
           (company_id, truck_type, material_weight_kg, distance_km,
            estimated_price_inr, range_low_inr, range_high_inr, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '${QUOTE_TTL_MINUTES} minutes')
         RETURNING id, estimated_price_inr, range_low_inr, range_high_inr, expires_at`,
        [
          companyId, dto.truckType, dto.materialWeightKg,
          Math.round(roadKm), estimated, low, high,
        ]
      );
      return rows[0];
    });
  }

  async confirmMarketPrice(companyId: string, quoteId: string, finalPriceInr: number) {
    if (!finalPriceInr || finalPriceInr <= 0) {
      throw new BadRequestException("INVALID_PRICE");
    }
    return this.db.withTenant(companyId, async (c) => {
      const { rows } = await c.query(
        `UPDATE price_quotes SET final_price_inr=$2, confirmed_at=now()
         WHERE id=$1 AND expires_at > now()
         RETURNING id, final_price_inr`,
        [quoteId, finalPriceInr]
      );
      if (!rows[0]) throw new BadRequestException("QUOTE_EXPIRED_OR_NOT_FOUND");
      return rows[0];
    });
  }

  async getQuote(companyId: string, quoteId: string) {
    return this.db.withTenant(companyId, async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM price_quotes WHERE id=$1 AND expires_at > now()`, [quoteId]
      );
      return rows[0] ?? null;
    });
  }

  private haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
}