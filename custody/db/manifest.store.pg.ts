/**
 * Postgres implementation of ManifestStore.
 *
 * Every method runs inside a tenant-scoped transaction. The store never sets
 * session variables itself — it receives a client from the caller's
 * transaction, so tenancy is decided once, at the request boundary, and
 * cannot be forgotten here.
 */

import type { PoolClient } from "pg";
import {
  ManifestSchema, canonicalManifest, type Manifest,
} from "@dtd/shared/manifest.schema";
import type { ManifestStore } from "../manifest/builder";

export class PgManifestStore implements ManifestStore {
  constructor(private client: PoolClient, private companyId: string) {}

  async put(m: Manifest & { chainTx: string }): Promise<void> {
    const { manifestId, ...rest } = m;
    await this.client.query(
      `INSERT INTO manifests
         (manifest_id, company_id, booking_id, trip_id, piece_count,
          loader_address, driver_address, receiver_address,
          canonical_json, chain_tx, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        manifestId, this.companyId, m.bookingId, m.tripId, m.pieceCount,
        m.loader, m.driver, m.receiver,
        canonicalManifest(rest), m.chainTx, m.createdAt,
      ]
    );
  }

  async get(manifestId: string): Promise<Manifest | null> {
    const { rows } = await this.client.query(
      `SELECT manifest_id, company_id, booking_id, trip_id, piece_count,
              loader_address, driver_address, receiver_address, created_at
       FROM manifests WHERE manifest_id = $1`,
      [manifestId]
    );
    if (!rows[0]) return null;
    return this.hydrate(rows[0]);
  }

  async getByBooking(bookingId: string): Promise<Manifest | null> {
    const { rows } = await this.client.query(
      `SELECT manifest_id, company_id, booking_id, trip_id, piece_count,
              loader_address, driver_address, receiver_address, created_at
       FROM manifests WHERE booking_id = $1`,
      [bookingId]
    );
    if (!rows[0]) return null;
    return this.hydrate(rows[0]);
  }

  /**
   * Bulk insert via UNNEST rather than N round-trips. A 200-piece manifest as
   * 200 INSERTs is 200 network hops on a loading dock's connection.
   */
  async indexPieces(manifestId: string, pieceIds: string[]): Promise<void> {
    await this.client.query(
      `INSERT INTO manifest_pieces (piece_id, manifest_id, company_id, seq)
       SELECT p.piece_id, $2, $3, p.seq
       FROM unnest($1::text[]) WITH ORDINALITY AS p(piece_id, seq)`,
      [pieceIds, manifestId, this.companyId]
    );
  }

  /**
   * The fork detector's hot path — one indexed lookup.
   * Runs WITHOUT tenant scoping by design: a piece scanned by a stranger in
   * another city must still resolve to its home manifest, or the double-scan
   * net cannot detect anything. Caller supplies a system-context client.
   */
  async findManifestByPiece(pieceId: string): Promise<string | null> {
    const { rows } = await this.client.query(
      `SELECT manifest_id FROM manifest_pieces WHERE piece_id = $1`,
      [pieceId]
    );
    return rows[0]?.manifest_id ?? null;
  }

  /** Full piece list, for label printing and reconciliation. */
  async piecesFor(manifestId: string): Promise<Array<{ pieceId: string; sku: string | null; weightKg: number | null }>> {
    const { rows } = await this.client.query(
      `SELECT piece_id, sku, weight_kg FROM manifest_pieces
       WHERE manifest_id = $1 ORDER BY seq`,
      [manifestId]
    );
    return rows.map((r: any) => ({
      pieceId: r.piece_id,
      sku: r.sku,
      weightKg: r.weight_kg === null ? null : Number(r.weight_kg),
    }));
  }

  /**
   * Integrity check: re-derive the hash from stored contents and compare to
   * the stored id. A mismatch means the row was edited outside this pipeline.
   */
  async verifyIntegrity(manifestId: string): Promise<boolean> {
    const { rows } = await this.client.query(
      `SELECT canonical_json FROM manifests WHERE manifest_id = $1`,
      [manifestId]
    );
    if (!rows[0]) return false;
    const { keccak256, toBytes } = await import("viem");
    return keccak256(toBytes(rows[0].canonical_json)) === manifestId;
  }

  private async hydrate(row: any): Promise<Manifest> {
    const pieces = await this.piecesFor(row.manifest_id);
    return ManifestSchema.parse({
      version: 1,
      manifestId: row.manifest_id,
      tripId: row.trip_id,
      bookingId: row.booking_id,
      transporterId: row.company_id,
      pieceCount: row.piece_count,
      pieces: pieces.map((p) => ({
        pieceId: p.pieceId,
        sku: p.sku ?? undefined,
        weightKg: p.weightKg ?? undefined,
      })),
      loader: row.loader_address,
      driver: row.driver_address,
      receiver: row.receiver_address,
      createdAt: row.created_at.toISOString(),
    });
  }
}