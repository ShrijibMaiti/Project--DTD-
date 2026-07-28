import { Injectable, NotFoundException } from "@nestjs/common";
import { keccak256 } from "viem";
import type { Hex } from "viem";
import { DatabaseService } from "../common/database.service";
import { AuditService } from "../common/audit.service";
import { publicClient, ADDRESSES, tripLogAbi, custodyAbi } from "@dtd/chain-sdk/anchor";

/**
 * The evidence packet — what makes claims "claim-ready":
 *   { booking, gpsBatches[], documents[], custodyStatus, insurancePolicy }
 * Every element carries its chain reference, so an insurer's desk (or the
 * lender portal) can independently re-verify every line without trusting DTD.
 * The packet itself is hashed too — evidence about the evidence.
 */
@Injectable()
export class ClaimsService {
  constructor(private db: DatabaseService, private audit: AuditService) {}

  async buildPacket(transporterId: string, userId: string, bookingId: string) {
    return this.db.withTenant(transporterId, async (c) => {
      const booking = await c.query(`SELECT * FROM bookings WHERE id=$1`, [bookingId]);
      if (!booking.rows[0]) throw new NotFoundException("BOOKING_NOT_FOUND");
      const b = booking.rows[0];

      const docs = await c.query(
        `SELECT doc_type, doc_hash, chain_tx, created_at
         FROM documents WHERE booking_id=$1 ORDER BY created_at`,
        [bookingId]
      );

      const policy = await c.query(
        `SELECT policy_number, declared_value_inr, premium_inr, status
         FROM insurance_policies WHERE booking_id=$1`,
        [bookingId]
      );

      // ---- chain reads (no keys needed; pure verification data) ----
      const tripId = (b.trip_id ?? keccak256(new TextEncoder().encode(bookingId))) as Hex;

      const batchCount = await publicClient.readContract({
        address: ADDRESSES.tripLogAnchor,
        abi: tripLogAbi,
        functionName: "batchCount",
        args: [tripId],
      });

      const gpsBatches = [];
      for (let i = 0n; i < batchCount; i++) {
        const batch = await publicClient.readContract({
          address: ADDRESSES.tripLogAnchor,
          abi: tripLogAbi,
          functionName: "getBatch",
          args: [tripId, i],
        });
        gpsBatches.push({
          index: Number(i),
          root: batch.root,
          fromTs: Number(batch.fromTs),
          toTs: Number(batch.toTs),
          anchoredAt: Number(batch.anchoredAt),
        });
      }

      let custodyStatus: number | null = null;
      if (b.manifest_id) {
        custodyStatus = await publicClient.readContract({
          address: ADDRESSES.custodyManifest,
          abi: custodyAbi,
          functionName: "status",
          args: [b.manifest_id as Hex],
        });
      }

      const packet = {
        version: 1,
        generatedAt: new Date().toISOString(),
        booking: {
          id: b.id, tripId, status: b.status,
          scheduledAt: b.scheduled_at, truckType: b.truck_type,
        },
        gps: { batchCount: Number(batchCount), batches: gpsBatches },
        documents: docs.rows,
        custody: { manifestId: b.manifest_id, status: custodyStatus },
        insurance: policy.rows[0] ?? null,
        chainRefs: {
          tripLogAnchor: ADDRESSES.tripLogAnchor,
          documentRegistry: ADDRESSES.documentRegistry,
          custodyManifest: ADDRESSES.custodyManifest,
        },
      };

      const packetJson = JSON.stringify(packet);
      const packetHash = keccak256(new TextEncoder().encode(packetJson));

      const { rows } = await c.query(
        `INSERT INTO claims_packets (transporter_id, booking_id, packet, packet_hash)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (booking_id) DO UPDATE
           SET packet=$3, packet_hash=$4, updated_at=now()
         RETURNING id, packet_hash, created_at`,
        [transporterId, bookingId, packetJson, packetHash]
      );

      await this.audit.record({
        transporterId, userId,
        action: "CLAIMS_PACKET_BUILT", entity: "claims_packet", entityId: rows[0].id,
        detail: { packetHash },
      });
      return { ...rows[0], packet };
    });
  }

  async getPacket(transporterId: string, bookingId: string) {
    return this.db.withTenant(transporterId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, packet, packet_hash, created_at, updated_at
         FROM claims_packets WHERE booking_id=$1`,
        [bookingId]
      );
      if (!rows[0]) throw new NotFoundException("NO_PACKET_YET");
      return { ...rows[0], packet: JSON.parse(rows[0].packet) };
    });
  }
}