/**
 * Postgres implementation of CustodyStore and AlertSink.
 *
 * custody_states is a CACHE. Every read path in the services re-syncs from the
 * chain before trusting it — this table exists so a dashboard listing 200 trips
 * doesn't make 200 RPC calls, not to be a source of truth.
 */

import type { PoolClient } from "pg";
import { CustodyStatus } from "@dtd/shared/manifest.schema";
import type { CustodyRecord, CustodyStore, AlertSink } from "../manifest/handoff";

/** Local copy — a pure mapping shouldn't drag the chain SDK into a DB store. */
function windowFor(status: CustodyStatus): CustodyRecord["window"] {
  switch (status) {
    case CustodyStatus.Created:   return "LOADING";
    case CustodyStatus.InCustody: return "TRANSIT";
    case CustodyStatus.Delivered: return "CLOSED";
    case CustodyStatus.Short:     return "UNLOADING";
    case CustodyStatus.Disputed:  return "DISPUTED";
    default:                      return "CLOSED";
  }
}

export class PgCustodyStore implements CustodyStore {
  constructor(private client: PoolClient, private companyId: string) {}

  async upsert(r: CustodyRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO custody_states
         (manifest_id, company_id, status, piece_count, delivered_count,
          loader_signed, driver_signed, receiver_signed,
          custody_start_at, delivered_at, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (manifest_id) DO UPDATE SET
         status = EXCLUDED.status,
         delivered_count = EXCLUDED.delivered_count,
         loader_signed = EXCLUDED.loader_signed,
         driver_signed = EXCLUDED.driver_signed,
         receiver_signed = EXCLUDED.receiver_signed,
         custody_start_at = EXCLUDED.custody_start_at,
         delivered_at = EXCLUDED.delivered_at,
         synced_at = now()`,
      [
        r.manifestId, this.companyId, r.status, r.pieceCount, r.deliveredCount,
        r.loaderSigned, r.driverSigned, r.receiverSigned,
        r.custodyStartAt, r.deliveredAt,
      ]
    );
  }

  async get(manifestId: string): Promise<CustodyRecord | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM custody_states WHERE manifest_id = $1`,
      [manifestId]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    const status = Number(r.status) as CustodyStatus;
    return {
      manifestId: r.manifest_id,
      status,
      window: windowFor(status),
      pieceCount: r.piece_count,
      deliveredCount: r.delivered_count,
      loaderSigned: r.loader_signed,
      driverSigned: r.driver_signed,
      receiverSigned: r.receiver_signed,
      custodyStartAt: r.custody_start_at === null ? null : Number(r.custody_start_at),
      deliveredAt: r.delivered_at === null ? null : Number(r.delivered_at),
    };
  }

  /** Ops dashboard: everything currently short or disputed. */
  async listNeedingAttention(): Promise<CustodyRecord[]> {
    const { rows } = await this.client.query(
      `SELECT * FROM custody_states
       WHERE status IN ($1, $2) ORDER BY synced_at DESC LIMIT 200`,
      [CustodyStatus.Short, CustodyStatus.Disputed]
    );
    return rows.map((r: any) => {
      const status = Number(r.status) as CustodyStatus;
      return {
        manifestId: r.manifest_id,
        status,
        window: windowFor(status),
        pieceCount: r.piece_count,
        deliveredCount: r.delivered_count,
        loaderSigned: r.loader_signed,
        driverSigned: r.driver_signed,
        receiverSigned: r.receiver_signed,
        custodyStartAt: r.custody_start_at === null ? null : Number(r.custody_start_at),
        deliveredAt: r.delivered_at === null ? null : Number(r.delivered_at),
      };
    });
  }
}

export class PgAlertSink implements AlertSink {
  constructor(private client: PoolClient, private companyId: string | null) {}

  async raise(e: {
    kind: string;
    manifestId: string;
    detail: Record<string, unknown>;
    severity: "INFO" | "WARN" | "CRITICAL";
  }): Promise<void> {
    // Only fork verdicts belong in fork_alerts; other kinds are operational
    // events and go to the platform audit log instead.
    const verdict = e.kind.startsWith("FORK_") ? e.kind.slice(5) : null;
    if (!verdict) return;

    await this.client.query(
      `INSERT INTO fork_alerts
         (piece_id, verdict, severity, manifest_id, company_id, detail, narrative)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        (e.detail as any).pieceId ?? "unknown",
        verdict,
        e.severity,
        e.manifestId === "unknown" ? null : e.manifestId,
        this.companyId,
        JSON.stringify(e.detail),
        (e.detail as any).narrative ?? null,
      ]
    );
  }

  async listOpen(limit = 50) {
    const { rows } = await this.client.query(
      `SELECT id, piece_id, verdict, severity, manifest_id, narrative, created_at
       FROM fork_alerts WHERE resolved_at IS NULL
       ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows;
  }

  async resolve(id: number, userId: string): Promise<void> {
    await this.client.query(
      `UPDATE fork_alerts SET resolved_at = now(), resolved_by = $2 WHERE id = $1`,
      [id, userId]
    );
  }
}