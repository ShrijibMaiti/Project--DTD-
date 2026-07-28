/**
 * platform/tests/helpers.ts
 *
 * Shared e2e test utilities: DB reset, company/fleet/booking seeding,
 * test JWT signing (matches DtdAuthGuard exactly — Domain 7's jwt.ts), and a
 * jest mock for chain/sdk/verify.ts's isReleasable() so payment tests
 * don't need a live anvil node.
 *
 * RLS CONTRACT — three session variables, each with one meaning:
 *   app.company_id  — the tenant uuid
 *   app.actor_role  — the RBAC role name, e.g. 'COMPANY_ADMIN'
 *   app.is_system   — 'true' only for privileged/platform operations
 *
 * Tables are FORCE ROW LEVEL SECURITY, so an INSERT with no matching session
 * state is REJECTED (42501), not silently dropped. Two consequences below:
 *
 *   1. `companies` has WITH CHECK (is_system() OR is_super_admin()) — only the
 *      platform creates companies, never a tenant. Seeding is legitimately a
 *      platform action, so seedTenant() sets app.is_system explicitly.
 *   2. Every tenant-scoped insert runs inside BEGIN / set_config / COMMIT.
 *
 * The tenant-isolation test is unaffected by (1): it goes through the HTTP API
 * with a normal company-scoped token, never through these helpers.
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
    // No RESTART IDENTITY: only audit_log.id uses a sequence, and TRUNCATE
    // ... RESTART IDENTITY requires sequence OWNERSHIP, which dtd_app
    // deliberately does not have.
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
        companies
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

// ---------------------------------------------------------------- company seeding

export interface SeededTenant {
  companyId: string;
  userId: string;
  legalName: string;
}

/**
 * Creates a company plus its COMPANY_ADMIN user.
 *
 * Runs with app.is_system = 'true' because creating a company is a platform
 * operation — the companies policy's WITH CHECK admits only is_system() or
 * is_super_admin(). The company/actor_role vars are also set so the users
 * insert satisfies tenant_ok(company_id) on its own terms.
 */
export async function seedTenant(legalName: string): Promise<SeededTenant> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.is_system', 'true', true)");

    const companyRes = await client.query(
      `INSERT INTO companies
         (legal_name, contact_phone, company_code, contact_email, status, plan)
       VALUES ($1, $2, $3, $4, 'ACTIVE', 'ENTERPRISE')
       RETURNING id`,
      [legalName, randomPhone(), randomCompanyCode(), randomEmail(legalName)]
    );
    const companyId: string = companyRes.rows[0].id;

    await client.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
    await client.query("SELECT set_config('app.actor_role', 'COMPANY_ADMIN', true)");

    // role must be a Domain 7 role — migration 0002 added a CHECK constraint
    // requiring every non-SUPER_ADMIN user to carry a company_id.
    const userRes = await client.query(
      `INSERT INTO users (company_id, full_name, phone, role)
       VALUES ($1, $2, $3, 'COMPANY_ADMIN')
       RETURNING id`,
      [companyId, `${legalName} Owner`, randomPhone()]
    );
    const userId: string = userRes.rows[0].id;

    await client.query("COMMIT");
    return { companyId, userId, legalName };
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

export async function seedTruckAndDriver(companyId: string): Promise<SeededFleet> {
  return withTenantTx(companyId, async (client) => {
    const truckRes = await client.query(
      `INSERT INTO trucks (company_id, reg_number, truck_type, capacity_kg, status)
       VALUES ($1, $2, 'OPEN_14FT', 14000, 'AVAILABLE')
       RETURNING id`,
      [companyId, randomRegNumber()]
    );
    const driverRes = await client.query(
      `INSERT INTO drivers (company_id, full_name, phone, license_number, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')
       RETURNING id`,
      [companyId, "Test Driver", randomPhone(), randomLicense()]
    );
    return { truckId: truckRes.rows[0].id, driverId: driverRes.rows[0].id };
  });
}

// ---------------------------------------------------------------- booking seeding

export async function seedBooking(companyId: string): Promise<string> {
  return withTenantTx(companyId, async (client) => {
    const quoteRes = await client.query(
      `INSERT INTO price_quotes
         (company_id, truck_type, material_weight_kg, distance_km,
          estimated_price_inr, range_low_inr, range_high_inr, expires_at)
       VALUES ($1, 'OPEN_14FT', 4000, 250, 15000, 14000, 16000, now() + interval '30 minutes')
       RETURNING id`,
      [companyId]
    );
    const quoteId: string = quoteRes.rows[0].id;

    const bookingRes = await client.query(
      `INSERT INTO bookings
         (company_id, quote_id, truck_type, material_weight_kg, scheduled_at,
          status, estimated_price_inr)
       VALUES ($1, $2, 'OPEN_14FT', 4000, now() + interval '1 day', 'CONFIRMED', 15000)
       RETURNING id`,
      [companyId, quoteId]
    );

    return bookingRes.rows[0].id;
  });
}

// ---------------------------------------------------------------- jwt

/**
 * Role-aware token, identical in shape to what LoginService issues.
 * Defaults to COMPANY_ADMIN on an ENTERPRISE module set so existing tests
 * pass every guard; narrow either argument to prove a 403 or a 402.
 */
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

/** For the 402 tests: a customer whose plan lacks the module. */
export function signPlanJwt(
  userId: string,
  companyId: string,
  plan: Plan,
  role: Role = Role.COMPANY_ADMIN
): string {
  return signTestJwt(userId, companyId, role, modulesForPlan(plan));
}

/** For the 403 tests: a real role with a full module set — permission is the gate. */
export function signRoleJwt(
  userId: string,
  companyId: string,
  role: Role
): string {
  return signTestJwt(userId, companyId, role, modulesForPlan(Plan.ENTERPRISE));
}

// ---------------------------------------------------------------- chain mock

export function mockChainIsReleasable(value: boolean) {
  (isReleasable as jest.Mock).mockResolvedValue(value);
}

// ---------------------------------------------------------------- internal

async function withTenantTx<T>(
  companyId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
    await client.query("SELECT set_config('app.actor_role', 'COMPANY_ADMIN', true)");
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

function randomPhone(): string {
  return "9" + Math.floor(100000000 + Math.random() * 899999999).toString();
}

function randomRegNumber(): string {
  return "DL" + Math.floor(1000 + Math.random() * 8999) + "TEST";
}

function randomLicense(): string {
  return "DL-" + Math.floor(1000000000 + Math.random() * 8999999999);
}

/** Crockford-style, no I/L/O/U — matches COMPANY_CODE_PATTERN. */
function randomCompanyCode(): string {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let s = "";
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return `DTD-${s}`;
}

function randomEmail(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  return `${slug}${Math.floor(Math.random() * 100000)}@test.invalid`;
}