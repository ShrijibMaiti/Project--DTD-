/**
 * Postgres implementation of PingBuffer and IngestMetrics.
 *
 * PingBuffer writes UNSIGNED pings (AcceptedPing) into gps_pings_raw — see
 * the KNOWN GAP note in schema.sql. Nothing currently drains this table into
 * the signed archive (gps_pings); that's a future signing worker, not this
 * store's job.
 *
 * IngestMetrics is an append-only event log, same philosophy as
 * platform.audit_log — one row per accept/reject, never mutated.
 */

import type { PoolClient } from "pg";
import type { AcceptedPing, PingBuffer, IngestMetrics, RejectReason } from "../ingest/gateway";

export class PgPingBuffer implements PingBuffer {
  constructor(private client: PoolClient, private companyId: string) {}

  async push(p: AcceptedPing): Promise<void> {
    await this.client.query(
      `INSERT INTO gps_pings_raw
         (device_id, truck_id, trip_id, company_id, lat, lng, ts,
          speed_kph, heading_deg, device_mac, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        p.deviceId, p.truckId, p.tripId, this.companyId, p.lat, p.lng, p.ts,
        p.speedKph ?? null, p.headingDeg ?? null, p.deviceMac ?? null, p.receivedAt,
      ]
    );
  }
}

export class PgIngestMetrics implements IngestMetrics {
  constructor(private client: PoolClient, private companyId: string | null) {}

  /**
   * Fire-and-forget by interface design (accepted/rejected return void, not
   * a Promise) — queued as a microtask so a slow metrics insert never blocks
   * the ingest hot path. Errors are swallowed deliberately: losing a metrics
   * row must never fail a real ping ingest.
   */
  accepted(deviceId: string): void {
    void this.client
      .query(
        `INSERT INTO gps_ingest_events (device_id, company_id, outcome)
         VALUES ($1,$2,'ACCEPTED')`,
        [deviceId, this.companyId]
      )
      .catch(() => {});
  }

  rejected(deviceId: string, reason: RejectReason): void {
    void this.client
      .query(
        `INSERT INTO gps_ingest_events (device_id, company_id, outcome, reject_reason)
         VALUES ($1,$2,'REJECTED',$3)`,
        [deviceId, this.companyId, reason]
      )
      .catch(() => {});
  }
}
