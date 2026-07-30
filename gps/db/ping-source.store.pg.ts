/**
 * Postgres implementation of PingSource, consumed by ProofApi.
 *
 * Reads the SIGNED archive (gps_pings) joined against gps_batches to find
 * which anchored batch covers a given instant — ProofApi needs the full set
 * of pings in that batch to rebuild the Merkle tree and produce a proof.
 */

import type { PoolClient } from "pg";
import type { PingSource } from "../query/proof-api";
import type { SignedPing } from "../signing/gateway-signer";

export class PgPingSource implements PingSource {
  constructor(private client: PoolClient) {}

  async batchPingsAt(
    tripId: string,
    ts: number
  ): Promise<{ pings: SignedPing[]; batchIndex: number } | null> {
    const { rows: batchRows } = await this.client.query(
      `SELECT batch_index, from_ts, to_ts FROM gps_batches
       WHERE trip_id = $1 AND batch_index IS NOT NULL
         AND from_ts <= $2 AND to_ts >= $2
       ORDER BY created_at DESC LIMIT 1`,
      [tripId, ts]
    );
    const batch = batchRows[0];
    if (!batch) return null;

    const { rows } = await this.client.query(
      `SELECT device_id, truck_id, trip_id, lat, lng, ts, speed_kph,
              received_at, signer_tier, signer_address, gateway_sig
       FROM gps_pings
       WHERE trip_id = $1 AND ts BETWEEN $2 AND $3
       ORDER BY ts`,
      [tripId, batch.from_ts, batch.to_ts]
    );

    return { pings: rows.map(toSignedPing), batchIndex: batch.batch_index };
  }

  async pingsInWindow(tripId: string, fromTs: number, toTs: number): Promise<SignedPing[]> {
    const { rows } = await this.client.query(
      `SELECT device_id, truck_id, trip_id, lat, lng, ts, speed_kph,
              received_at, signer_tier, signer_address, gateway_sig
       FROM gps_pings
       WHERE trip_id = $1 AND ts BETWEEN $2 AND $3
       ORDER BY ts`,
      [tripId, fromTs, toTs]
    );
    return rows.map(toSignedPing);
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
