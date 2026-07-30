/**
 * custody/tests/stores.integration.test.ts
 *
 * The in-memory fakes proved the LOGIC. This proves the STORES: real Postgres,
 * real RLS, real constraints. Everything the fakes couldn't catch —
 * tenant leakage, the append-only guarantee, nonce idempotency under
 * concurrency, and the CHECK constraints — lives here.
 *
 * Requires: docker container dtd-postgres-test running, schema applied.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool, type PoolClient } from "pg";
import { randomUUID } from "crypto";
import { keccak256, toBytes, toHex, type Hex } from "viem";
import { canonicalManifest, CustodyStatus, type Manifest } from "@dtd/shared/manifest.schema";
import { ScanContext } from "@dtd/shared/scan-event.schema";
import { PgManifestStore } from "../db/manifest.store.pg";
import { PgLifecycleStore } from "../db/lifecycle.store.pg";
import { PgCustodyStore, PgAlertSink } from "../db/custody.store.pg";
import { LifecycleIndex } from "../doublescan/lifecycle-index";
import { ReconcileCounter } from "../reconcile/counter";
import { generatePieceIds } from "../qr/generator";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://dtd_app:dtd_app_pw@localhost:5433/dtd_test",
});

/**
 * Superuser pool, used ONLY for test cleanup.
 *
 * scan_events REVOKEs UPDATE and DELETE from PUBLIC — append-only is a
 * PRIVILEGE, not a policy, so dtd_app genuinely cannot delete scans no matter
 * what session context it sets. That is the point of the design, and it means
 * tests need superuser to reset between runs.
 */
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

/** Mirrors DatabaseService.withActor — tenancy set once, at the boundary. */
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
let bookingA: string;
let bookingB: string;

async function seedCompany(name: string): Promise<{ companyId: string; bookingId: string }> {
  return asSystem(async (c) => {
    const co = await c.query(
      `INSERT INTO companies
         (legal_name, contact_phone, company_code, contact_email, status, plan)
       VALUES ($1,'9000000000',$2,$3,'ACTIVE','ENTERPRISE') RETURNING id`,
      [name, `DTD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
       `${Math.random().toString(36).slice(2)}@test.invalid`]
    );
    const companyId = co.rows[0].id;

    const q = await c.query(
      `INSERT INTO price_quotes
         (company_id, truck_type, material_weight_kg, distance_km,
          estimated_price_inr, range_low_inr, range_high_inr, expires_at)
       VALUES ($1,'OPEN_14FT',4000,250,15000,14000,16000, now() + interval '1 day')
       RETURNING id`,
      [companyId]
    );
    const b = await c.query(
      `INSERT INTO bookings
         (company_id, quote_id, truck_type, material_weight_kg, scheduled_at,
          status, estimated_price_inr)
       VALUES ($1,$2,'OPEN_14FT',4000, now() + interval '1 day','CONFIRMED',15000)
       RETURNING id`,
      [companyId, q.rows[0].id]
    );
    return { companyId, bookingId: b.rows[0].id };
  });
}

function buildManifest(
  companyId: string,
  bookingId: string,
  pieceCount: number
): Manifest & { chainTx: string } {
  const pieces = generatePieceIds(pieceCount).map((pieceId) => ({ pieceId }));
  const draft = {
    version: 1 as const,
    tripId: keccak256(toHex(`trip-${bookingId}`)),
    bookingId,
    companyId,
    pieceCount,
    pieces,
    loader: "0x1111111111111111111111111111111111111111",
    driver: "0x2222222222222222222222222222222222222222",
    receiver: "0x3333333333333333333333333333333333333333",
    createdAt: new Date().toISOString(),
  };
  return {
    ...draft,
    manifestId: keccak256(toBytes(canonicalManifest(draft))),
    chainTx: "0x" + "ab".repeat(32),
  };
}

// ---------------------------------------------------------------- lifecycle

beforeAll(async () => {
  const a = await seedCompany("Store Test A");
  const b = await seedCompany("Store Test B");
  companyA = a.companyId; bookingA = a.bookingId;
  companyB = b.companyId; bookingB = b.bookingId;
});

afterAll(async () => {
  await asAdmin(async (c) => {
    await c.query(`DELETE FROM scan_events`);
    await c.query(`DELETE FROM bookings WHERE company_id = ANY($1)`, [[companyA, companyB]]);
    await c.query(`DELETE FROM price_quotes WHERE company_id = ANY($1)`, [[companyA, companyB]]);
    await c.query(`DELETE FROM companies WHERE id = ANY($1)`, [[companyA, companyB]]);
  });
  await pool.end();
  await adminPool.end();
});

beforeEach(async () => {
  await asAdmin(async (c) => {
    await c.query(`DELETE FROM scan_events`);
    await c.query(`DELETE FROM fork_alerts`);
    await c.query(`DELETE FROM custody_states`);
    await c.query(`DELETE FROM manifest_pieces`);
    await c.query(`DELETE FROM manifests`);
  });
});

// ================================================================
describe("PgManifestStore", () => {
  it("persists a 200-piece manifest and reads it back intact", async () => {
    const m = buildManifest(companyA, bookingA, 200);

    await withTenant(companyA, async (c) => {
      const store = new PgManifestStore(c, companyA);
      await store.put(m);
      await store.indexPieces(m.manifestId, m.pieces.map((p) => p.pieceId));
    });

    const read = await withTenant(companyA, (c) =>
      new PgManifestStore(c, companyA).get(m.manifestId)
    );

    expect(read).not.toBeNull();
    expect(read!.pieceCount).toBe(200);
    expect(read!.pieces).toHaveLength(200);
    expect(read!.bookingId).toBe(bookingA);
  });

  it("INTEGRITY: the stored id re-derives from the stored contents", async () => {
    const m = buildManifest(companyA, bookingA, 10);
    await withTenant(companyA, async (c) => {
      const s = new PgManifestStore(c, companyA);
      await s.put(m);
      await s.indexPieces(m.manifestId, m.pieces.map((p) => p.pieceId));
    });

    const ok = await withTenant(companyA, (c) =>
      new PgManifestStore(c, companyA).verifyIntegrity(m.manifestId)
    );
    expect(ok).toBe(true);
  });

  it("one manifest per booking — the database refuses a second", async () => {
    const m1 = buildManifest(companyA, bookingA, 5);
    await withTenant(companyA, (c) => new PgManifestStore(c, companyA).put(m1));

    const m2 = { ...buildManifest(companyA, bookingA, 7) };
    await expect(
      withTenant(companyA, (c) => new PgManifestStore(c, companyA).put(m2))
    ).rejects.toThrow();
  });

  it("piece ids are globally unique — the same box cannot join two shipments", async () => {
    const m1 = buildManifest(companyA, bookingA, 5);
    await withTenant(companyA, async (c) => {
      const s = new PgManifestStore(c, companyA);
      await s.put(m1);
      await s.indexPieces(m1.manifestId, m1.pieces.map((p) => p.pieceId));
    });

    const m2 = buildManifest(companyB, bookingB, 5);
    await withTenant(companyB, (c) => new PgManifestStore(c, companyB).put(m2));

    // Company B tries to claim one of A's pieces.
    await expect(
      withTenant(companyB, (c) =>
        new PgManifestStore(c, companyB).indexPieces(m2.manifestId, [m1.pieces[0].pieceId])
      )
    ).rejects.toThrow();
  });

  it("TENANT ISOLATION: company B cannot read company A's manifest", async () => {
    const m = buildManifest(companyA, bookingA, 5);
    await withTenant(companyA, (c) => new PgManifestStore(c, companyA).put(m));

    const leaked = await withTenant(companyB, (c) =>
      new PgManifestStore(c, companyB).get(m.manifestId)
    );
    expect(leaked).toBeNull();
  });

  it("TENANT ISOLATION: company B cannot write into company A's tenancy", async () => {
    const m = buildManifest(companyA, bookingA, 5);
    // B supplies A's company id but is scoped to B — WITH CHECK must reject.
    await expect(
      withTenant(companyB, (c) => new PgManifestStore(c, companyA).put(m))
    ).rejects.toThrow();
  });

  it("findManifestByPiece resolves cross-tenant under system context", async () => {
    const m = buildManifest(companyA, bookingA, 5);
    await withTenant(companyA, async (c) => {
      const s = new PgManifestStore(c, companyA);
      await s.put(m);
      await s.indexPieces(m.manifestId, m.pieces.map((p) => p.pieceId));
    });

    // The fork detector runs as system: a stranger's scan must still resolve.
    const found = await asSystem((c) =>
      new PgManifestStore(c, companyA).findManifestByPiece(m.pieces[0].pieceId)
    );
    expect(found).toBe(m.manifestId);
  });
});

// ================================================================
describe("PgLifecycleStore", () => {
  let m: Manifest & { chainTx: string };

  beforeEach(async () => {
    m = buildManifest(companyA, bookingA, 200);
    await withTenant(companyA, async (c) => {
      const s = new PgManifestStore(c, companyA);
      await s.put(m);
      await s.indexPieces(m.manifestId, m.pieces.map((p) => p.pieceId));
    });
  });

  async function scan(pieceIds: string[], nonce?: (i: number) => string) {
    await withTenant(companyA, async (c) => {
      const idx = new LifecycleIndex(new PgLifecycleStore(c, companyA));
      for (let i = 0; i < pieceIds.length; i++) {
        await idx.record({
          pieceId: pieceIds[i],
          manifestId: m.manifestId,
          context: ScanContext.UNLOADING,
          scannerId: "godown-1",
          clientNonce: nonce?.(i),
        });
      }
    });
  }

  it("records scans and reads a piece's full history", async () => {
    await scan([m.pieces[0].pieceId]);
    const history = await withTenant(companyA, (c) =>
      new LifecycleIndex(new PgLifecycleStore(c, companyA)).history(m.pieces[0].pieceId)
    );
    expect(history).toHaveLength(1);
    expect(history[0].context).toBe(ScanContext.UNLOADING);
  });

  it("OFFLINE QUEUE: replaying the same nonce inserts nothing new", async () => {
    const p = m.pieces[0].pieceId;
    await scan([p], () => "nonce-1");
    await scan([p], () => "nonce-1");
    await scan([p], () => "nonce-1");

    const history = await withTenant(companyA, (c) =>
      new LifecycleIndex(new PgLifecycleStore(c, companyA)).history(p)
    );
    expect(history).toHaveLength(1);
  });

  it("APPEND-ONLY: the database refuses UPDATE and DELETE on scan_events", async () => {
    await scan([m.pieces[0].pieceId]);

    await expect(
      withTenant(companyA, (c) =>
        c.query(`UPDATE scan_events SET location_hint = 'edited'`)
      )
    ).rejects.toThrow();

    await expect(
      withTenant(companyA, (c) => c.query(`DELETE FROM scan_events`))
    ).rejects.toThrow();
  });

  it("records a scan for a piece id that exists in NO manifest", async () => {
    // A forged QR must still be recorded — that sighting is the intelligence.
    await withTenant(companyA, async (c) => {
      const idx = new LifecycleIndex(new PgLifecycleStore(c, companyA));
      await idx.record({
        pieceId: "DTD-ZZZZZZZZZZ",
        manifestId: null,
        context: ScanContext.PUBLIC_VERIFY,
        scannerId: null,
      });
    });

    const history = await asSystem((c) =>
      new LifecycleIndex(new PgLifecycleStore(c, null)).history("DTD-ZZZZZZZZZZ")
    );
    expect(history).toHaveLength(1);
  });
});

// ================================================================
describe("Reconciliation against Postgres", () => {
  let m: Manifest & { chainTx: string };

  beforeEach(async () => {
    m = buildManifest(companyA, bookingA, 200);
    await withTenant(companyA, async (c) => {
      const s = new PgManifestStore(c, companyA);
      await s.put(m);
      await s.indexPieces(m.manifestId, m.pieces.map((p) => p.pieceId));
    });
  });

  async function scanFirst(n: number) {
    await withTenant(companyA, async (c) => {
      const idx = new LifecycleIndex(new PgLifecycleStore(c, companyA));
      for (const p of m.pieces.slice(0, n)) {
        await idx.record({
          pieceId: p.pieceId,
          manifestId: m.manifestId,
          context: ScanContext.UNLOADING,
          scannerId: "godown-1",
        });
      }
    });
  }

  it("200/200 reconciles complete", async () => {
    await scanFirst(200);
    const r = await withTenant(companyA, (c) =>
      new ReconcileCounter(
        new PgManifestStore(c, companyA),
        new LifecycleIndex(new PgLifecycleStore(c, companyA))
      ).reconcile(m.manifestId)
    );
    expect(r.scanned).toBe(200);
    expect(r.missing).toBe(0);
    expect(r.complete).toBe(true);
  });

  it("THE CORE CASE: 175/200 names the 25 missing pieces", async () => {
    await scanFirst(175);
    const r = await withTenant(companyA, (c) =>
      new ReconcileCounter(
        new PgManifestStore(c, companyA),
        new LifecycleIndex(new PgLifecycleStore(c, companyA))
      ).reconcile(m.manifestId)
    );
    expect(r.scanned).toBe(175);
    expect(r.missing).toBe(25);
    expect(r.missingPieceIds).toHaveLength(25);
    expect(r.complete).toBe(false);
  });
});

// ================================================================
describe("PgCustodyStore", () => {
  let m: Manifest & { chainTx: string };

  beforeEach(async () => {
    m = buildManifest(companyA, bookingA, 200);
    await withTenant(companyA, (c) => new PgManifestStore(c, companyA).put(m));
  });

  it("upserts and reads a custody record", async () => {
    await withTenant(companyA, (c) =>
      new PgCustodyStore(c, companyA).upsert({
        manifestId: m.manifestId,
        status: CustodyStatus.InCustody,
        window: "TRANSIT",
        pieceCount: 200,
        deliveredCount: 0,
        loaderSigned: true,
        driverSigned: true,
        receiverSigned: false,
        custodyStartAt: 1_760_000_000,
        deliveredAt: null,
      })
    );

    const rec = await withTenant(companyA, (c) =>
      new PgCustodyStore(c, companyA).get(m.manifestId)
    );
    expect(rec!.status).toBe(CustodyStatus.InCustody);
    expect(rec!.window).toBe("TRANSIT");
  });

  it("CONSTRAINT: delivered_count can never exceed piece_count", async () => {
    await expect(
      withTenant(companyA, (c) =>
        new PgCustodyStore(c, companyA).upsert({
          manifestId: m.manifestId,
          status: CustodyStatus.Delivered,
          window: "CLOSED",
          pieceCount: 200,
          deliveredCount: 201,
          loaderSigned: true,
          driverSigned: true,
          receiverSigned: true,
          custodyStartAt: 1,
          deliveredAt: 2,
        })
      )
    ).rejects.toThrow();
  });
});

// ================================================================
describe("PgAlertSink", () => {
  it("persists a fork verdict with its narrative", async () => {
    await withTenant(companyA, (c) =>
      new PgAlertSink(c, companyA).raise({
        kind: "FORK_POST_CLOSURE_SIGHTING",
        manifestId: "unknown",
        detail: { pieceId: "DTD-ABCDEFGHJK", narrative: "seen alive after closure" },
        severity: "CRITICAL",
      })
    );

    const open = await withTenant(companyA, (c) => new PgAlertSink(c, companyA).listOpen());
    expect(open).toHaveLength(1);
    expect(open[0].verdict).toBe("POST_CLOSURE_SIGHTING");
  });

  it("ignores non-fork operational events", async () => {
    await withTenant(companyA, (c) =>
      new PgAlertSink(c, companyA).raise({
        kind: "CUSTODY_TRANSITION",
        manifestId: "x",
        detail: {},
        severity: "INFO",
      })
    );
    const open = await withTenant(companyA, (c) => new PgAlertSink(c, companyA).listOpen());
    expect(open).toHaveLength(0);
  });
});