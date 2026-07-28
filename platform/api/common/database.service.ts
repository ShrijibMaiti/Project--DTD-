/**
 * The only path to Postgres. Every tenant-scoped query runs inside
 * withTenant(), which SETs app.transporter_id for the transaction so
 * the RLS policies in db/rls-policies.sql are enforced by the DB itself —
 * application code CANNOT forget tenant isolation.
 */
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool, PoolClient } from "pg";

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

  /** Tenant-scoped transaction. transporterId comes from auth, never from input. */
  async withTenant<T>(
    transporterId: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.transporter_id', $1, true)", [
        transporterId,
      ]);
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

  /** For system jobs (webhooks, workers) that legitimately cross tenants. */
  async asSystem<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.role', 'system', true)");
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