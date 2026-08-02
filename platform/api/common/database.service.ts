/**
 * The only path to Postgres. Every tenant-scoped query runs inside
 * withActor(), which sets THREE session variables consumed by the RLS
 * policies in db/rls-policies.sql:
 *
 *   app.company_id  — the tenant uuid
 *   app.actor_role  — the RBAC role, so SUPER_ADMIN can cross tenants
 *   app.is_system   — 'true' only for jobs and webhooks
 *
 * Application code CANNOT forget tenant isolation: the database enforces it.
 *
 * ---------------------------------------------------------------------------
 * PHASE B ADDITION — transaction participation.
 *
 * withActorOn() / withTenantOn() take an OPTIONAL existing client. When one is
 * supplied they simply run the callback on it, joining the caller's open
 * transaction instead of opening a second one.
 *
 * This exists because cross-domain orchestration composes three services that
 * each used to open their own transaction. Nesting them meant one request held
 * three PoolClients simultaneously — against `max: 20`, roughly seven
 * concurrent trip-starts would deadlock, each holding clients and waiting for
 * one that is never released. It would never appear under --runInBand and
 * would appear immediately under load.
 *
 * Sharing one client fixes that AND buys real atomicity: booking assignment,
 * GPS binding and manifest persistence now commit or roll back together.
 *
 * The session variables are deliberately NOT re-set when joining an existing
 * transaction. They are already set by whoever opened it, and `set_config(...,
 * true)` is transaction-local — re-setting them with a different actor would
 * silently re-scope the caller's transaction mid-flight. If a nested call ever
 * needs a different actor, it needs its own transaction, and that should be an
 * explicit decision rather than an accident.
 */
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool, PoolClient } from "pg";
import type { Role } from "@dtd/shared/roles.schema";

export interface DbActor {
  companyId: string | null;
  role: Role;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
  });

  async onModuleDestroy() {
    await this.pool.end();
  }

  /**
   * Actor-scoped transaction. The actor comes from the verified JWT
   * (DtdAuthGuard), never from request input.
   */
  async withActor<T>(
    actor: DbActor,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.company_id', $1, true)", [
        actor.companyId ?? "",
      ]);
      await client.query("SELECT set_config('app.actor_role', $1, true)", [
        actor.role,
      ]);
      await client.query("SELECT set_config('app.is_system', 'false', true)");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Join an existing transaction when a client is supplied, otherwise open a
   * new one. This is what lets a service method be called either standalone
   * (from its own controller) or as one step of an orchestrated flow.
   */
  async withActorOn<T>(
    actor: DbActor,
    existing: PoolClient | null | undefined,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    if (existing) return fn(existing);
    return this.withActor(actor, fn);
  }

  /**
   * Back-compat shim so the existing service files keep working while
   * controllers are migrated one at a time. Treats the id as the company id
   * and assumes COMPANY_ADMIN scope.
   *
   * DELETE THIS once every caller passes a real actor — a shim that
   * hardcodes a role is exactly the kind of thing that outlives its welcome.
   */
  async withTenant<T>(
    companyId: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    return this.withActor({ companyId, role: "COMPANY_ADMIN" as Role }, fn);
  }

  /** withTenant, with transaction participation. See withActorOn. */
  async withTenantOn<T>(
    companyId: string,
    existing: PoolClient | null | undefined,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    if (existing) return fn(existing);
    return this.withTenant(companyId, fn);
  }

  /** For system jobs (webhooks, workers) that legitimately cross tenants. */
  async asSystem<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.is_system', 'true', true)");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
