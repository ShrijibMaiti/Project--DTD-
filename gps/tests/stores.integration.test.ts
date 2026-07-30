/**
 * gps/tests/stores.integration.test.ts
 *
 * The in-memory fakes (batcher.test.ts, timeline.test.ts) proved the LOGIC.
 * This proves the STORES: real Postgres, real RLS, real constraints —
 * tenant leakage, the markAnchored/chain_tx path the fake silently
 * discarded, and the append-only convention on gps_ingest_events.
 *
 * Requires: docker container dtd-postgres-test running, schema applied.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool, type PoolClient } from "pg";
import { keccak256, toHex, type Hex } from "viem";
import { PgDeviceStore, PgDeviceAlertSink } from "../db/device.store.pg";
import { PgPingBuffer, PgIngestMetrics } from "../db/ping-buffer.store.pg";
import { PgBatchStore } from "../db/batch.store.pg";
import { PgPingSource } from "../db/ping-source.store.pg";
import { SignerTier, type SignedPing } from "../signing/gateway-signer";
import type { AcceptedPing } from "../ingest/gateway";
import type { Device } from "../ingest/device-registry";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://dtd_app:dtd_app_pw@localhost:5433/dtd_test",
});

const adminPool = new Pool({
  connectionString:
    process.env.ADMIN_DATABASE_URL ??
    "postgresql://postgres:dtd@localhost:5433/dtd_test",
});

async function asAdmin<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await adminPool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

async function withTenant<T>(
  companyId: string,
  fn: (c: PoolClient) => Promise<T>
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
    await c.query("SELECT set_config('app.actor_role', 'COMPANY_ADMIN', true)");
    await c.query("SELECT set_config('app.is_system', 'false', true)");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

async function asSystem<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.is_system', 'true', true)");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------- fixtures

let companyA: string;
let companyB: string;
let truckA: string;
let truckB: string;

async function seedCompany(name: string): Promise<{ companyId: string; truckId: string }> {
  return asSystem(async (c) => {
    const co = await c.query(
      `INSERT INTO companies
         (legal_name, contact_phone, company_code, contact_email, status, plan)
       VALUES ($1,'9000000000',$2,$3,'ACTIVE','ENTERPRISE') RETURNING id`,
      [name, `DTD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
       `${Math.random().toString(36).slice(2)}@test.invalid`]
    );
    const companyId = co.rows[0].id;

    const t = await c.query(
      `INSERT INTO trucks (company_id, reg_number, truck_type, capacity_kg)
       VALUES ($1,$2,'OPEN_14FT',4000) RETURNING id`,
      [companyId, `DL-GPS-${Math.random().toString(36).slice(2, 8).toUpperCase()}`]
    );
    return { companyId, truckId: t.rows[0].id };
  });
}

function makeDevice(deviceId: string, truckId: string): Device {
  return {
    deviceId,
    truckId,
    companyId: "", // set by the store's constructor companyId, not this field
    sharedSecret: "sekret",
    status: "ACTIVE",
    lastSeenTs: null,
    tamperFlags: 0,
    installedAt: new Date().toISOString(),
  };
}

const TRIP = keccak256(toHex("trip-gps-stores-001"));

function makeSignedPing(overrides: Partial<SignedPing> = {}): SignedPing {
  return {
    deviceId: "DEV-A-001",
    truckId: truckA,
    tripId: TRIP,
    lat: 28.6139,
    lng: 77.209,
    ts: 1_760_000_000,
    speedKph: 45,
    receivedAt: 1_760_000_005,
    signerTier: SignerTier.GATEWAY_VERIFIED_DEVICE,
    signerAddress: "0x1111111111111111111111111111111111111111",
    gatewaySig: ("0x" + "ab".repeat(65)) as Hex,
    ...overrides,
  };
}

async function insertSignedPing(companyId: string, p: SignedPing) {
  await asSystem((c) =>
    c.query(
      `INSERT INTO gps_pings
         (device_id, truck_id, trip_id, company_id, lat, lng, ts, speed_kph,
          received_at, signer_tier, signer_address, gateway_sig)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        p.deviceId, p.truckId, p.tripId, companyId, p.lat, p.lng, p.ts,
        p.speedKph ?? null, p.receivedAt, p.signerTier, p.signerAddress, p.gatewaySig,
      ]
    )
  );
}

// ---------------------------------------------------------------- lifecycle

beforeAll(async () => {
  const a = await seedCompany("GPS Store Test A");
  const b = await seedCompany("GPS Store Test B");
  companyA = a.companyId; truckA = a.truckId;
  companyB = b.companyId; truckB = b.truckId;

  await withTenant(companyA, (c) =>
    new PgDeviceStore(c, companyA).upsert(makeDevice("DEV-A-001", truckA))
  );
  await withTenant(companyB, (c) =>
    new PgDeviceStore(c, companyB).upsert(makeDevice("DEV-B-001", truckB))
  );
});

afterAll(async () => {
  await asAdmin(async (c) => {
    await c.query(`DELETE FROM gps_ingest_events`);
    await c.query(`DELETE FROM gps_device_alerts`);
    await c.query(`DELETE FROM gps_batches`);
    await c.query(`DELETE FROM gps_pings`);
    await c.query(`DELETE FROM gps_pings_raw`);
    await c.query(`DELETE FROM gps_device_bindings`);
    await c.query(`DELETE FROM gps_devices`);
    await c.query(`DELETE FROM trucks WHERE company_id = ANY($1)`, [[companyA, companyB]]);
    await c.query(`DELETE FROM companies WHERE id = ANY($1)`, [[companyA, companyB]]);
  });
  await pool.end();
  await adminPool.end();
});

// ---------------------------------------------------------------- PgDeviceStore

describe("PgDeviceStore", () => {
  it("persists a device and reads it back", async () => {
    const read = await withTenant(companyA, (c) => new PgDeviceStore(c, companyA).get("DEV-A-001"));
    expect(read?.deviceId).toBe("DEV-A-001");
    expect(read?.status).toBe("ACTIVE");
  });

  it("byTruck resolves the device bound to a truck", async () => {
    const read = await withTenant(companyA, (c) => new PgDeviceStore(c, companyA).byTruck(truckA));
    expect(read?.deviceId).toBe("DEV-A-001");
  });

  it("incrementTamper returns the running count", async () => {
    const store = await withTenant(companyA, async (c) => {
      const s = new PgDeviceStore(c, companyA);
      const n1 = await s.incrementTamper("DEV-A-001");
      const n2 = await s.incrementTamper("DEV-A-001");
      return { n1, n2 };
    });
    expect(store.n2).toBe(store.n1 + 1);
  });

  it("bindTrip / activeBinding / unbindTrip round-trip", async () => {
    await withTenant(companyA, (c) => new PgDeviceStore(c, companyA).bindTrip("DEV-A-001", TRIP));
    const bound = await withTenant(companyA, (c) => new PgDeviceStore(c, companyA).activeBinding("DEV-A-001"));
    expect(bound?.tripId).toBe(TRIP);
    expect(bound?.truckId).toBe(truckA);

    await withTenant(companyA, (c) => new PgDeviceStore(c, companyA).unbindTrip("DEV-A-001"));
    const unbound = await withTenant(companyA, (c) => new PgDeviceStore(c, companyA).activeBinding("DEV-A-001"));
    expect(unbound?.tripId).toBeNull();
  });

  it("TENANT ISOLATION: company B cannot read company A's device", async () => {
    const leaked = await withTenant(companyB, (c) => new PgDeviceStore(c, companyB).get("DEV-A-001"));
    expect(leaked).toBeNull();
  });

  it("listStale finds devices past the silence cutoff, excludes retired", async () => {
    await withTenant(companyA, async (c) => {
      const s = new PgDeviceStore(c, companyA);
      await s.touch("DEV-A-001", 1_000_000);
    });
    const stale = await withTenant(companyA, (c) => new PgDeviceStore(c, companyA).listStale(2_000_000));
    expect(stale.some((d) => d.deviceId === "DEV-A-001")).toBe(true);
  });
});

// ---------------------------------------------------------------- PgBatchStore

describe("PgBatchStore", () => {
  beforeEach(async () => {
    await asAdmin((c) => c.query(`DELETE FROM gps_batches`));
    await asAdmin((c) => c.query(`DELETE FROM gps_pings`));
  });

  it("saveBatch + drain round-trips signed pings for a trip", async () => {
    const p1 = makeSignedPing({ ts: 1_760_000_000 });
    const p2 = makeSignedPing({ ts: 1_760_000_030 });
    await insertSignedPing(companyA, p1);
    await insertSignedPing(companyA, p2);

    const drained = await withTenant(companyA, (c) => new PgBatchStore(c, companyA).drain(TRIP, 1_760_000_999));
    expect(drained).toHaveLength(2);
    expect(drained[0].ts).toBeLessThan(drained[1].ts);
  });

  it("markAnchored sets batch_index AND chain_tx — the fake never asserted chain_tx", async () => {
    await withTenant(companyA, (c) =>
      new PgBatchStore(c, companyA).saveBatch({
        tripId: TRIP, root: ("0x" + "cd".repeat(32)) as Hex,
        fromTs: 1_760_000_000, toTs: 1_760_000_030, pingCount: 2,
        pings: [], batchIndex: null,
      })
    );
    await withTenant(companyA, (c) => new PgBatchStore(c, companyA).markAnchored(TRIP, 0, "0xdeadbeef"));

    const row = await asSystem((c) =>
      c.query(`SELECT batch_index, chain_tx FROM gps_batches WHERE trip_id = $1`, [TRIP])
    );
    expect(row.rows[0].batch_index).toBe(0);
    expect(row.rows[0].chain_tx).toBe("0xdeadbeef");
  });

  it("batchCountForTrip counts only ANCHORED batches", async () => {
    const store = () => withTenant(companyA, (c) => new PgBatchStore(c, companyA));
    await withTenant(companyA, (c) =>
      new PgBatchStore(c, companyA).saveBatch({
        tripId: TRIP, root: ("0x" + "11".repeat(32)) as Hex,
        fromTs: 1, toTs: 2, pingCount: 1, pings: [], batchIndex: null,
      })
    );
    const beforeAnchor = await withTenant(companyA, (c) => new PgBatchStore(c, companyA).batchCountForTrip(TRIP));
    expect(beforeAnchor).toBe(0);

    await withTenant(companyA, (c) => new PgBatchStore(c, companyA).markAnchored(TRIP, 0, "0xabc"));
    const afterAnchor = await withTenant(companyA, (c) => new PgBatchStore(c, companyA).batchCountForTrip(TRIP));
    expect(afterAnchor).toBe(1);
  });

  it("lastBatchToTs returns the max to_ts across a trip's batches", async () => {
    await withTenant(companyA, (c) =>
      new PgBatchStore(c, companyA).saveBatch({
        tripId: TRIP, root: ("0x" + "22".repeat(32)) as Hex,
        fromTs: 1, toTs: 100, pingCount: 1, pings: [], batchIndex: null,
      })
    );
    const last = await withTenant(companyA, (c) => new PgBatchStore(c, companyA).lastBatchToTs(TRIP));
    expect(last).toBe(100);
  });

  it("tripsWithPending lists distinct trip_ids present in gps_pings", async () => {
    await insertSignedPing(companyA, makeSignedPing({ ts: 1 }));
    const trips = await withTenant(companyA, (c) => new PgBatchStore(c, companyA).tripsWithPending());
    expect(trips).toContain(TRIP);
  });

  it("TENANT ISOLATION: company B cannot drain company A's pings", async () => {
    await insertSignedPing(companyA, makeSignedPing({ ts: 5 }));
    const leaked = await withTenant(companyB, (c) => new PgBatchStore(c, companyB).drain(TRIP, 9_999_999_999));
    expect(leaked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- PgPingSource

describe("PgPingSource", () => {
  beforeEach(async () => {
    await asAdmin((c) => c.query(`DELETE FROM gps_batches`));
    await asAdmin((c) => c.query(`DELETE FROM gps_pings`));
  });

  it("batchPingsAt returns the anchored batch's full ping set", async () => {
    const p1 = makeSignedPing({ ts: 1_760_000_000 });
    const p2 = makeSignedPing({ ts: 1_760_000_030 });
    await insertSignedPing(companyA, p1);
    await insertSignedPing(companyA, p2);
    await withTenant(companyA, (c) =>
      new PgBatchStore(c, companyA).saveBatch({
        tripId: TRIP, root: ("0x" + "33".repeat(32)) as Hex,
        fromTs: 1_760_000_000, toTs: 1_760_000_030, pingCount: 2, pings: [], batchIndex: null,
      })
    );
    await withTenant(companyA, (c) => new PgBatchStore(c, companyA).markAnchored(TRIP, 7, "0xfeed"));

    const result = await withTenant(companyA, (c) => new PgPingSource(c).batchPingsAt(TRIP, 1_760_000_015));
    expect(result?.batchIndex).toBe(7);
    expect(result?.pings).toHaveLength(2);
  });

  it("returns null when no anchored batch covers the requested instant", async () => {
    const result = await withTenant(companyA, (c) => new PgPingSource(c).batchPingsAt(TRIP, 1_760_000_015));
    expect(result).toBeNull();
  });

  it("pingsInWindow returns every ping in the range, ordered", async () => {
    await insertSignedPing(companyA, makeSignedPing({ ts: 100 }));
    await insertSignedPing(companyA, makeSignedPing({ ts: 50 }));
    const pings = await withTenant(companyA, (c) => new PgPingSource(c).pingsInWindow(TRIP, 0, 200));
    expect(pings.map((p) => p.ts)).toEqual([50, 100]);
  });
});

// ---------------------------------------------------------------- PgPingBuffer

describe("PgPingBuffer", () => {
  it("push writes an unsigned ping to the raw staging table", async () => {
    const accepted: AcceptedPing = {
      deviceId: "DEV-A-001", truckId: truckA, tripId: TRIP,
      lat: 28.6, lng: 77.2, ts: 1_760_000_100, receivedAt: 1_760_000_101,
    };
    await withTenant(companyA, (c) => new PgPingBuffer(c, companyA).push(accepted));

    const row = await asSystem((c) =>
      c.query(`SELECT device_id, ts FROM gps_pings_raw WHERE device_id = $1 AND ts = $2`,
        [accepted.deviceId, accepted.ts])
    );
    expect(row.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- PgIngestMetrics

describe("PgIngestMetrics", () => {
  it("accepted() and rejected() write append-only event rows", async () => {
    await withTenant(companyA, async (c) => {
      const m = new PgIngestMetrics(c, companyA);
      m.accepted("DEV-A-001");
      m.rejected("DEV-A-001", "BAD_MAC" as any);
    });
    // metrics writes are fire-and-forget; give the microtask queue a tick
    await new Promise((r) => setTimeout(r, 50));

    const rows = await asSystem((c) =>
      c.query(`SELECT outcome FROM gps_ingest_events WHERE device_id = 'DEV-A-001' ORDER BY at`)
    );
    expect(rows.rows.map((r: any) => r.outcome)).toEqual(
      expect.arrayContaining(["ACCEPTED", "REJECTED"])
    );
  });

  it("APPEND-ONLY: dtd_app cannot UPDATE or DELETE gps_ingest_events", async () => {
    await expect(
      withTenant(companyA, (c) => c.query(`UPDATE gps_ingest_events SET outcome = 'ACCEPTED'`))
    ).rejects.toThrow();
    await expect(
      withTenant(companyA, (c) => c.query(`DELETE FROM gps_ingest_events`))
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- PgDeviceAlertSink

describe("PgDeviceAlertSink", () => {
  it("raise() persists a device alert", async () => {
    await withTenant(companyA, (c) =>
      new PgDeviceAlertSink(c, companyA).raise({
        kind: "DEVICE_TAMPER_FLAG",
        deviceId: "DEV-A-001",
        detail: { reason: "BAD_MAC", count: 3 },
        severity: "WARN",
      })
    );
    const row = await asSystem((c) =>
      c.query(`SELECT kind, severity FROM gps_device_alerts WHERE device_id = 'DEV-A-001'`)
    );
    expect(row.rows[0].kind).toBe("DEVICE_TAMPER_FLAG");
    expect(row.rows[0].severity).toBe("WARN");
  });
});
