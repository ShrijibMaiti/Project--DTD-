/**
 * platform/tests/helpers.ts
 *
 * Shared e2e test utilities: DB reset, tenant/fleet/booking seeding,
 * test JWT signing (matches DtdAuthGuard exactly — Domain 7's jwt.ts), and a
 * jest mock for chain/sdk/verify.ts's isReleasable() so payment tests
 * don't need a live anvil node.
 *
 * IMPORTANT: seeding uses the same SET LOCAL app.company_id / app.actor_role
 * pattern as DatabaseService.withTenant() — RLS is FORCE ROW LEVEL SECURITY,
 * so a plain INSERT with no app.company_id set will be silently rejected
 * (0 rows affected, no error) rather than throwing. Every tenant-scoped
 * seed insert below runs inside BEGIN / SET LOCAL / ... / COMMIT.
 */
import { Pool, PoolClient } from "pg";
import { isReleasable } from "@dtd/chain-sdk/verify";
import { signAccessToken } from "@dtd/identity/auth/jwt";
import { Role } from "@dtd/shared/roles.schema";
import { Plan, modulesForPlan, type PlatformModule } from "@dtd/shared/modules.schema";

// ---------------------------------------------------------------- pool

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function closeTestPool() {
  await pool.end();
}

// ---------------------------------------------------------------- reset

export async function resetDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.is_system', 'true', true)");
    await client.query(`
      TRUNCATE TABLE
        audit_log,
        support_messages,
        support_tickets,
        claims_packets,
        documents,
        payments,
        insurance_policies,
        kyc_records,
        booking_stops,
        bookings,
        price_quotes,
        drivers,
        trucks,
        users,
        transporters
      CASCADE
    `);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- tenant seeding

export interface SeededTenant {
  transporterId: string;
  userId: string;
  legalName: string;
}

export async function seedTenant(legalName: string): Promise<SeededTenant> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const transporterRes = await client.query(
      `INSERT INTO transporters (legal_name, contact_phone)
       VALUES ($1, $2)
       RETURNING id`,
      [legalName, randomPhone()]
    );
    const transporterId: string = transporterRes.rows[0].id;

    await client.query("SELECT set_config('app.company_id', $1, true)", [transporterId]);
    await client.query("SELECT set_config('app.actor_role', 'COMPANY_ADMIN', true)");

    const userRes = await client.query(
      `INSERT INTO users (company_id, full_name, phone, role)
       VALUES ($1, $2, $3, 'OWNER')
       RETURNING id`,
      [transporterId, `${legalName} Owner`, randomPhone()]
    );
    const userId: string = userRes.rows[0].id;

    await client.query("COMMIT");
    return { transporterId, userId, legalName };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- fleet seeding

export interface SeededFleet {
  truckId: string;
  driverId: string;
}

export async function seedTruckAndDriver(transporterId: string): Promise<SeededFleet> {
  return withTenantTx(transporterId, async (client) => {
    const truckRes = await client.query(
      `INSERT INTO trucks (company_id, reg_number, truck_type, capacity_kg, status)
       VALUES ($1, $2, 'OPEN_14FT', 14000, 'AVAILABLE')
       RETURNING id`,
      [transporterId, randomRegNumber()]
    );
    const driverRes = await client.query(
      `INSERT INTO drivers (company_id, full_name, phone, license_number, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')
       RETURNING id`,
      [transporterId, "Test Driver", randomPhone(), randomLicense()]
    );
    return { truckId: truckRes.rows[0].id, driverId: driverRes.rows[0].id };
  });
}

// ---------------------------------------------------------------- booking seeding

export async function seedBooking(transporterId: string): Promise<string> {
  return withTenantTx(transporterId, async (client) => {
    const quoteRes = await client.query(
      `INSERT INTO price_quotes
         (company_id, truck_type, material_weight_kg, distance_km,
          estimated_price_inr, range_low_inr, range_high_inr, expires_at)
       VALUES ($1, 'OPEN_14FT', 4000, 250, 15000, 14000, 16000, now() + interval '30 minutes')
       RETURNING id`,
      [transporterId]
    );
    const quoteId: string = quoteRes.rows[0].id;

    const bookingRes = await client.query(
      `INSERT INTO bookings
         (company_id, quote_id, truck_type, material_weight_kg, scheduled_at,
          status, estimated_price_inr)
       VALUES ($1, $2, 'OPEN_14FT', 4000, now() + interval '1 day', 'CONFIRMED', 15000)
       RETURNING id`,
      [transporterId, quoteId]
    );

    return bookingRes.rows[0].id;
  });
}

// ---------------------------------------------------------------- jwt

export function signTestJwt(
  userId: string,
  companyId: string | null,
  role: Role = Role.COMPANY_ADMIN,
  modules: PlatformModule[] = modulesForPlan(Plan.ENTERPRISE)
): string {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET not set — check .env.test is loaded");
  }
  return signAccessToken(
    { sub: userId, companyId, role, modules, tokenVersion: 1 },
    process.env.JWT_SECRET
  );
}

export function signPlanJwt(
  userId: string,
  companyId: string,
  plan: Plan,
  role: Role = Role.COMPANY_ADMIN
): string {
  return signTestJwt(userId, companyId, role, modulesForPlan(plan));
}

// ---------------------------------------------------------------- chain mock

export function mockChainIsReleasable(value: boolean) {
  (isReleasable as jest.Mock).mockResolvedValue(value);
}

// ---------------------------------------------------------------- internal

async function withTenantTx<T>(
  transporterId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.company_id', $1, true)", [transporterId]);
    await client.query("SELECT set_config('app.actor_role', 'COMPANY_ADMIN', true)");
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

function randomPhone(): string {
  return "9" + Math.floor(100000000 + Math.random() * 899999999).toString();
}

function randomRegNumber(): string {
  return "DL" + Math.floor(1000 + Math.random() * 8999) + "TEST";
}

function randomLicense(): string {
  return "DL-" + Math.floor(1000000000 + Math.random() * 8999999999);
}