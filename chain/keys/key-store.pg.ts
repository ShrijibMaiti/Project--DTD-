/**
 * chain/keys/key-store.pg.ts
 * Concrete KeyStore for SignerService. Two implementations, and the second
 * one exists for a specific architectural reason.
 *
 * PgKeyStore        — normal use: reads/writes participant_keys on a client.
 * PreloadedKeyStore — holds ONE record in memory for the duration of a
 *                     request, so SignerService.signDigest() can be called
 *                     from inside an already-open tenant transaction without
 *                     acquiring a second PoolClient.
 *
 * WHY PreloadedKeyStore matters: ReleaseGate.confirmAndSign() calls
 * signer.signDigest() in the middle of a flow that also runs reconciliation
 * and alerting against a tenant-scoped client. If the signer opened its own
 * connection there, every confirm-delivery request would hold two clients
 * simultaneously — halving effective pool capacity and creating a classic
 * nested-acquisition deadlock under load. Preloading keeps it at one.
 *
 * It also has a correctness benefit: key lookup and OTP consumption commit
 * independently of the delivery transaction, so a failed delivery cannot
 * silently un-consume an OTP and leave it replayable.
 */

import type { PoolClient } from "pg";
import type { Address } from "viem";
import type { KeyRecord, KeyStore } from "./signer-service";

function toRecord(row: any): KeyRecord {
  return {
    phone: row.phone,
    address: row.address as Address,
    encKey: row.enc_key,
    iv: row.iv,
    authTag: row.auth_tag,
    createdAt: new Date(row.created_at).getTime(),
    exportedAt: row.exported_at ? new Date(row.exported_at).getTime() : null,
  };
}

export class PgKeyStore implements KeyStore {
  /**
   * @param client MUST be a system-context client (DatabaseService.asSystem).
   *               participant_keys has a system_only RLS policy with no
   *               super-admin escape hatch, so a tenant client reads nothing.
   */
  constructor(private client: PoolClient) {}

  async get(phone: string): Promise<KeyRecord | null> {
    const { rows } = await this.client.query(
      `SELECT phone, address, enc_key, iv, auth_tag, created_at, exported_at
       FROM participant_keys WHERE phone = $1`,
      [phone]
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async put(rec: KeyRecord): Promise<void> {
    // DO NOTHING, not DO UPDATE: a key is minted once per phone. Overwriting
    // would silently orphan every signature and reputation entry made with
    // the previous key.
    await this.client.query(
      `INSERT INTO participant_keys (phone, address, enc_key, iv, auth_tag)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (phone) DO NOTHING`,
      [rec.phone, rec.address, rec.encKey, rec.iv, rec.authTag]
    );
  }

  async markExported(phone: string): Promise<void> {
    await this.client.query(
      `UPDATE participant_keys SET exported_at = now() WHERE phone = $1`,
      [phone]
    );
  }
}

/**
 * Serves a single pre-fetched record from memory. Writes are buffered and
 * must be flushed by the caller afterwards.
 */
export class PreloadedKeyStore implements KeyStore {
  private pendingPut: KeyRecord | null = null;
  private pendingExport = false;

  constructor(private record: KeyRecord | null) {}

  async get(phone: string): Promise<KeyRecord | null> {
    if (this.record && this.record.phone === phone) return this.record;
    return null;
  }

  async put(rec: KeyRecord): Promise<void> {
    this.record = rec;
    this.pendingPut = rec;
  }

  async markExported(_phone: string): Promise<void> {
    this.pendingExport = true;
  }

  /** Persist anything the signer created during the request. */
  async flush(client: PoolClient): Promise<void> {
    const pg = new PgKeyStore(client);
    if (this.pendingPut) {
      await pg.put(this.pendingPut);
      this.pendingPut = null;
    }
    if (this.pendingExport && this.record) {
      await pg.markExported(this.record.phone);
      this.pendingExport = false;
    }
  }

  get hasPendingWrites(): boolean {
    return this.pendingPut !== null || this.pendingExport;
  }
}
