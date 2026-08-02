/**
 * chain/keys/signer-audit.pg.ts
 * Concrete AuditLog for SignerService.
 *
 * signer-service.ts writes an audit row BEFORE releasing a signature. That
 * ordering is deliberate — if the process dies mid-sign, the attempt is still
 * on record. Preserving it here means the buffered variant must be flushed by
 * the caller even on the failure path.
 */

import type { PoolClient } from "pg";
import type { Address, Hex } from "viem";
import type { AuditLog } from "./signer-service";

export interface SignerAuditEvent {
  phone: string;
  address: Address;
  digest: Hex;
  action: "KEY_CREATED" | "SIGNED" | "EXPORTED";
  at: number;
}

export class PgSignerAudit implements AuditLog {
  /** @param client MUST be system-context — signer_audit is system_only RLS. */
  constructor(private client: PoolClient) {}

  async record(event: SignerAuditEvent): Promise<void> {
    await this.client.query(
      `INSERT INTO signer_audit (phone, address, digest, action, at)
       VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0))`,
      [
        event.phone,
        event.address || null,
        event.digest && event.digest !== "0x" ? event.digest : null,
        event.action,
        event.at,
      ]
    );
  }
}

/**
 * Buffers audit events in memory so SignerService can be driven from inside
 * an already-open tenant transaction without acquiring a second connection.
 * Same rationale as PreloadedKeyStore.
 *
 * The caller MUST call flush() in a finally block — an unflushed buffer is a
 * silently lost audit trail, which is worse than no audit trail because it
 * looks like nothing happened.
 */
export class BufferedSignerAudit implements AuditLog {
  private events: SignerAuditEvent[] = [];

  async record(event: SignerAuditEvent): Promise<void> {
    this.events.push(event);
  }

  async flush(client: PoolClient): Promise<number> {
    if (this.events.length === 0) return 0;
    const pg = new PgSignerAudit(client);
    for (const e of this.events) await pg.record(e);
    const n = this.events.length;
    this.events = [];
    return n;
  }

  get pending(): number {
    return this.events.length;
  }
}
