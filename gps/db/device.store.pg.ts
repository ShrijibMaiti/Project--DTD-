/**
 * Postgres implementation of DeviceStore and DeviceAlertSink.
 *
 * Mirrors custody's PgCustodyStore/PgAlertSink pairing: one file, two small
 * stores, because they're always injected together into DeviceRegistry.
 */

import type { PoolClient } from "pg";
import type { Device, DeviceStatus, Binding, DeviceStore, DeviceAlertSink } from "../ingest/device-registry";

export class PgDeviceStore implements DeviceStore {
  constructor(private client: PoolClient, private companyId: string) {}

  async get(deviceId: string): Promise<Device | null> {
    const { rows } = await this.client.query(
      `SELECT device_id, truck_id, company_id, shared_secret, status,
              last_seen_ts, tamper_flags, installed_at
       FROM gps_devices WHERE device_id = $1`,
      [deviceId]
    );
    if (!rows[0]) return null;
    return hydrate(rows[0]);
  }

  async byTruck(truckId: string): Promise<Device | null> {
    const { rows } = await this.client.query(
      `SELECT device_id, truck_id, company_id, shared_secret, status,
              last_seen_ts, tamper_flags, installed_at
       FROM gps_devices WHERE truck_id = $1`,
      [truckId]
    );
    if (!rows[0]) return null;
    return hydrate(rows[0]);
  }

  async upsert(d: Device): Promise<void> {
    await this.client.query(
      `INSERT INTO gps_devices
         (device_id, truck_id, company_id, shared_secret, status,
          last_seen_ts, tamper_flags, installed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (device_id) DO UPDATE SET
         truck_id = EXCLUDED.truck_id,
         shared_secret = EXCLUDED.shared_secret,
         status = EXCLUDED.status,
         last_seen_ts = EXCLUDED.last_seen_ts,
         tamper_flags = EXCLUDED.tamper_flags`,
      [
        d.deviceId, d.truckId, this.companyId, d.sharedSecret, d.status,
        d.lastSeenTs, d.tamperFlags, d.installedAt,
      ]
    );
  }

  async setStatus(deviceId: string, status: DeviceStatus): Promise<void> {
    await this.client.query(
      `UPDATE gps_devices SET status = $2 WHERE device_id = $1`,
      [deviceId, status]
    );
  }

  async touch(deviceId: string, ts: number): Promise<void> {
    await this.client.query(
      `UPDATE gps_devices SET last_seen_ts = $2 WHERE device_id = $1`,
      [deviceId, ts]
    );
  }

  async incrementTamper(deviceId: string): Promise<number> {
    const { rows } = await this.client.query(
      `UPDATE gps_devices SET tamper_flags = tamper_flags + 1
       WHERE device_id = $1 RETURNING tamper_flags`,
      [deviceId]
    );
    return rows[0]?.tamper_flags ?? 0;
  }

  async activeBinding(deviceId: string): Promise<Binding | null> {
    const { rows } = await this.client.query(
      `SELECT b.device_id, d.truck_id, b.trip_id, b.since
       FROM gps_device_bindings b
       JOIN gps_devices d ON d.device_id = b.device_id
       WHERE b.device_id = $1`,
      [deviceId]
    );
    if (!rows[0]) return null;
    return {
      deviceId: rows[0].device_id,
      truckId: rows[0].truck_id,
      tripId: rows[0].trip_id,
      since: Number(rows[0].since),
    };
  }

  /** Upsert-on-bind: a device has at most one active binding row. */
  async bindTrip(deviceId: string, tripId: string): Promise<void> {
    await this.client.query(
      `INSERT INTO gps_device_bindings (device_id, company_id, trip_id, since)
       VALUES ($1,$2,$3, extract(epoch from now())::bigint)
       ON CONFLICT (device_id) DO UPDATE SET
         trip_id = EXCLUDED.trip_id,
         since = EXCLUDED.since`,
      [deviceId, this.companyId, tripId]
    );
  }

  async unbindTrip(deviceId: string): Promise<void> {
    await this.client.query(
      `UPDATE gps_device_bindings SET trip_id = NULL WHERE device_id = $1`,
      [deviceId]
    );
  }

  async listStale(olderThanTs: number): Promise<Device[]> {
    const { rows } = await this.client.query(
      `SELECT device_id, truck_id, company_id, shared_secret, status,
              last_seen_ts, tamper_flags, installed_at
       FROM gps_devices
       WHERE status = 'ACTIVE' AND (last_seen_ts IS NULL OR last_seen_ts < $1)`,
      [olderThanTs]
    );
    return rows.map(hydrate);
  }
}

function hydrate(row: any): Device {
  return {
    deviceId: row.device_id,
    truckId: row.truck_id,
    companyId: row.company_id,
    sharedSecret: row.shared_secret,
    status: row.status,
    lastSeenTs: row.last_seen_ts === null ? null : Number(row.last_seen_ts),
    tamperFlags: row.tamper_flags,
    installedAt: row.installed_at.toISOString(),
  };
}

export class PgDeviceAlertSink implements DeviceAlertSink {
  constructor(private client: PoolClient, private companyId: string | null) {}

  async raise(e: {
    kind: string;
    deviceId: string;
    detail: Record<string, unknown>;
    severity: "INFO" | "WARN" | "CRITICAL";
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO gps_device_alerts (device_id, company_id, kind, severity, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [e.deviceId, this.companyId, e.kind, e.severity, JSON.stringify(e.detail)]
    );
  }
}
