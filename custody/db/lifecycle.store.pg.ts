/**
 * Postgres implementation of LifecycleStore — the append-only scan log.
 *
 * No update or delete methods exist on this class, and the table revokes both
 * at the database level. If a scan was wrong, the correction is another scan,
 * never an edit.
 */

import type { PoolClient } from "pg";
import { ScanContext, type ScanEvent } from "@dtd/shared/scan-event.schema";
import type { LifecycleStore } from "../doublescan/lifecycle-index";

export class PgLifecycleStore implements LifecycleStore {
  constructor(private client: PoolClient, private companyId: string | null) {}

  /**
   * ON CONFLICT DO NOTHING against the (piece_id, client_nonce) index is the
   * whole offline-queue story: the godown scanner can flush the same batch
   * five times on flaky wifi and the count stays correct.
   */
  async append(e: ScanEvent): Promise<{ inserted: boolean }> {
    const { rows } = await this.client.query(
      `INSERT INTO scan_events
         (scan_id, piece_id, manifest_id, company_id, context,
          scanner_id, location_hint, scanned_at, client_nonce)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (piece_id, client_nonce) WHERE client_nonce IS NOT NULL DO NOTHING
       RETURNING scan_id`,
      [
        e.scanId, e.pieceId, e.manifestId, this.companyId, e.context,
        e.scannerId, e.locationHint, e.scannedAt, e.clientNonce ?? null,
      ]
    );
    return { inserted: rows.length > 0 };
  }

  async byPiece(pieceId: string): Promise<ScanEvent[]> {
    const { rows } = await this.client.query(
      `SELECT scan_id, piece_id, manifest_id, context, scanner_id,
              location_hint, scanned_at, client_nonce
       FROM scan_events WHERE piece_id = $1 ORDER BY scanned_at`,
      [pieceId]
    );
    return rows.map(toScanEvent);
  }

  async byManifest(manifestId: string, context?: ScanContext): Promise<ScanEvent[]> {
    const { rows } = context
      ? await this.client.query(
          `SELECT scan_id, piece_id, manifest_id, context, scanner_id,
                  location_hint, scanned_at, client_nonce
           FROM scan_events WHERE manifest_id = $1 AND context = $2
           ORDER BY scanned_at`,
          [manifestId, context]
        )
      : await this.client.query(
          `SELECT scan_id, piece_id, manifest_id, context, scanner_id,
                  location_hint, scanned_at, client_nonce
           FROM scan_events WHERE manifest_id = $1 ORDER BY scanned_at`,
          [manifestId]
        );
    return rows.map(toScanEvent);
  }

  /** Distinct pieces — the reconciliation count, computed in the database. */
  async distinctPieces(manifestId: string, context: ScanContext): Promise<string[]> {
    const { rows } = await this.client.query(
      `SELECT DISTINCT piece_id FROM scan_events
       WHERE manifest_id = $1 AND context = $2`,
      [manifestId, context]
    );
    return rows.map((r: any) => r.piece_id);
  }

  /** Pieces touched recently — the nightly fork sweep's candidate set. */
  async recentlyActivePieces(sinceHours = 24): Promise<string[]> {
    const { rows } = await this.client.query(
      `SELECT DISTINCT piece_id FROM scan_events
       WHERE recorded_at > now() - ($1 || ' hours')::interval`,
      [sinceHours]
    );
    return rows.map((r: any) => r.piece_id);
  }
}

function toScanEvent(r: any): ScanEvent {
  return {
    version: 1,
    scanId: r.scan_id,
    pieceId: r.piece_id,
    manifestId: r.manifest_id,
    context: r.context as ScanContext,
    scannerId: r.scanner_id,
    locationHint: r.location_hint,
    scannedAt: r.scanned_at.toISOString(),
    clientNonce: r.client_nonce ?? undefined,
  };
}