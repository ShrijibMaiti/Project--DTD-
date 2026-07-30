/**
 * Postgres implementation of BatchStore (for MerkleBatcher) and AnchorLookup
 * (for TimelineBuilder).
 *
 * drain() reads from the SIGNED archive (gps_pings) — see schema.sql's
 * KNOWN GAP note: nothing currently populates gps_pings from gps_pings_raw.
 * This store is correct against the interface as written; the missing
 * signing worker is a separate, later piece of work.
 */

import type { PoolClient } from "pg";
import type { Batch, BatchStore } from "../batching/merkle-batcher";
import type { SignedPing } from "../signing/gateway-signer";
import type { AnchorLookup } from "../journey/timeline";

export class PgBatchStore implements BatchStore, AnchorLookup {
  constructor(private client: PoolClient, private companyId: string) {}

  async drain(tripId: string, upToTs: number): Promise<SignedPing[]> {
    const { rows } = await this.client.query(
      `SELECT device_id, truck_id, trip_id, lat, lng, ts, speed_kph,
              received_at, signer_tier, signer_address, gateway_sig
       FROM gps_pings
       WHERE trip_id = $1 AND ts <= $2
       ORDER BY ts`,
      [tripId, upToTs]
    );
    return rows.map(toSignedPing);
  }

  async saveBatch(b: Batch & { batchIndex: number | null }): Promise<void> {
    await this.client.query(
      `INSERT INTO gps_batches
         (trip_id, company_id, root, from_ts, to_ts, ping_count, batch_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [b.tripId, this.companyId, b.root, b.fromTs, b.toTs, b.pingCount, b.batchIndex]
    );
  }

  /**
   * Targets the oldest unanchored row for the trip — reproduces
   * InMemoryBatchStore's find(x => x.batchIndex === null) first-match
   * behavior from the test fake, not a redesign.
   *
   * Persists chain_tx, which the fake silently discards (its markAnchored
   * ignores the txHash param entirely) — this store does more than the fake
   * did, not something the fake ever asserted against.
   */
  async markAnchored(tripId: string, batchIndex: number, txHash: string): Promise<void> {
    await this.client.query(
      `UPDATE gps_batches SET batch_index = $2, chain_tx = $3, anchored_at = now()
       WHERE id = (
         SELECT id FROM gps_batches
         WHERE trip_id = $1 AND batch_index IS NULL
         ORDER BY created_at ASC LIMIT 1
       )`,
      [tripId, batchIndex, txHash]
    );
  }

  async lastBatchToTs(tripId: string): Promise<number | null> {
    const { rows } = await this.client.query(
      `SELECT MAX(to_ts) AS max_to_ts FROM gps_batches WHERE trip_id = $1`,
      [tripId]
    );
    return rows[0]?.max_to_ts === null ? null : Number(rows[0].max_to_ts);
  }

  async tripsWithPending(): Promise<string[]> {
    const { rows } = await this.client.query(`SELECT DISTINCT trip_id FROM gps_pings`);
    return rows.map((r: any) => r.trip_id);
  }

  /** AnchorLookup — TimelineBuilder only cares about ANCHORED batches. */
  async batchCountForTrip(tripId: string): Promise<number> {
    const { rows } = await this.client.query(
      `SELECT COUNT(*)::int AS n FROM gps_batches
       WHERE trip_id = $1 AND batch_index IS NOT NULL`,
      [tripId]
    );
    return rows[0]?.n ?? 0;
  }
}

function toSignedPing(r: any): SignedPing {
  return {
    deviceId: r.device_id,
    truckId: r.truck_id,
    tripId: r.trip_id,
    lat: Number(r.lat),
    lng: Number(r.lng),
    ts: Number(r.ts),
    speedKph: r.speed_kph === null ? undefined : Number(r.speed_kph),
    receivedAt: Number(r.received_at),
    signerTier: r.signer_tier,
    signerAddress: r.signer_address,
    gatewaySig: r.gateway_sig,
  };
}
