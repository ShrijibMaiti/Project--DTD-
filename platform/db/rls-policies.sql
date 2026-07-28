-- Tenant isolation, unified with identity/db/rls-policies.sql.
--
-- THREE session variables, each with exactly one meaning:
--   app.company_id  — the tenant UUID
--   app.actor_role  — the RBAC role name, e.g. 'COMPANY_ADMIN'
--   app.is_system   — 'true' ONLY for background jobs and webhooks
--
-- RLS answers "whose rows are these?". RBAC (identity/rbac/guards.ts) answers
-- "what may this user do with them?". Neither substitutes for the other.
--
-- REQUIRED: the app must connect as a NOSUPERUSER NOBYPASSRLS role (dtd_app).
-- A superuser connection silently voids every policy below.
--
-- NOTE ON WITH CHECK: every policy below carries BOTH a USING clause (reads)
-- and a WITH CHECK clause (writes). Do NOT add separate FOR INSERT policies —
-- once any INSERT-specific policy exists on a table, Postgres stops deriving
-- the write check from USING, and inserts on tables lacking one fail with
-- 42501. One policy per table, both clauses, is the only safe shape here.

CREATE OR REPLACE FUNCTION current_company() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::uuid
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_actor_role() RETURNS text AS $$
  SELECT COALESCE(NULLIF(current_setting('app.actor_role', true), ''), '')
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_super_admin() RETURNS boolean AS $$
  SELECT current_actor_role() = 'SUPER_ADMIN'
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_system() RETURNS boolean AS $$
  SELECT COALESCE(NULLIF(current_setting('app.is_system', true), ''), 'false') = 'true'
$$ LANGUAGE sql STABLE;

/* One predicate, used by every policy. Named so the intent is unmissable. */
CREATE OR REPLACE FUNCTION tenant_ok(row_tenant uuid) RETURNS boolean AS $$
  SELECT is_system() OR is_super_admin() OR row_tenant = current_company()
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------- enable
ALTER TABLE trucks              ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucks              FORCE  ROW LEVEL SECURITY;
ALTER TABLE drivers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers             FORCE  ROW LEVEL SECURITY;
ALTER TABLE price_quotes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_quotes        FORCE  ROW LEVEL SECURITY;
ALTER TABLE bookings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings            FORCE  ROW LEVEL SECURITY;
ALTER TABLE booking_stops       ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_stops       FORCE  ROW LEVEL SECURITY;
ALTER TABLE kyc_records         ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc_records         FORCE  ROW LEVEL SECURITY;
ALTER TABLE insurance_policies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_policies  FORCE  ROW LEVEL SECURITY;
ALTER TABLE payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments            FORCE  ROW LEVEL SECURITY;
ALTER TABLE documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents           FORCE  ROW LEVEL SECURITY;
ALTER TABLE claims_packets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims_packets      FORCE  ROW LEVEL SECURITY;
ALTER TABLE support_tickets     ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets     FORCE  ROW LEVEL SECURITY;
ALTER TABLE support_messages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages    FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- idempotency
DROP POLICY IF EXISTS tenant_isolation ON trucks;
DROP POLICY IF EXISTS tenant_isolation ON drivers;
DROP POLICY IF EXISTS tenant_isolation ON price_quotes;
DROP POLICY IF EXISTS tenant_isolation ON bookings;
DROP POLICY IF EXISTS tenant_isolation ON booking_stops;
DROP POLICY IF EXISTS tenant_isolation ON kyc_records;
DROP POLICY IF EXISTS tenant_isolation ON insurance_policies;
DROP POLICY IF EXISTS tenant_isolation ON payments;
DROP POLICY IF EXISTS tenant_isolation ON documents;
DROP POLICY IF EXISTS tenant_isolation ON claims_packets;
DROP POLICY IF EXISTS tenant_isolation ON support_tickets;
DROP POLICY IF EXISTS tenant_isolation ON support_messages;

-- ---------------------------------------------------------------- policies
-- transporter_id is the tenant column and holds the SAME uuid as companies.id.
-- Migration B renames it to company_id.
CREATE POLICY tenant_isolation ON trucks
  USING (tenant_ok(transporter_id)) WITH CHECK (tenant_ok(transporter_id));
CREATE POLICY tenant_isolation ON drivers
  USING (tenant_ok(transporter_id)) WITH CHECK (tenant_ok(transporter_id));
CREATE POLICY tenant_isolation ON price_quotes
  USING (tenant_ok(transporter_id)) WITH CHECK (tenant_ok(transporter_id));
CREATE POLICY tenant_isolation ON bookings
  USING (tenant_ok(transporter_id)) WITH CHECK (tenant_ok(transporter_id));
CREATE POLICY tenant_isolation ON kyc_records
  USING (tenant_ok(transporter_id)) WITH CHECK (tenant_ok(transporter_id));
CREATE POLICY tenant_isolation ON insurance_policies
  USING (tenant_ok(transporter_id)) WITH CHECK (tenant_ok(transporter_id));
CREATE POLICY tenant_isolation ON payments
  USING (tenant_ok(transporter_id)) WITH CHECK (tenant_ok(transporter_id));
CREATE POLICY tenant_isolation ON documents
  USING (tenant_ok(transporter_id)) WITH CHECK (tenant_ok(transporter_id));
CREATE POLICY tenant_isolation ON claims_packets
  USING (tenant_ok(transporter_id)) WITH CHECK (tenant_ok(transporter_id));
CREATE POLICY tenant_isolation ON support_tickets
  USING (tenant_ok(transporter_id)) WITH CHECK (tenant_ok(transporter_id));

-- Child tables inherit isolation through their parent FK.
CREATE POLICY tenant_isolation ON booking_stops
  USING (
    is_system() OR is_super_admin() OR EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.id = booking_stops.booking_id
        AND b.transporter_id = current_company()
    )
  )
  WITH CHECK (
    is_system() OR is_super_admin() OR EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.id = booking_stops.booking_id
        AND b.transporter_id = current_company()
    )
  );

CREATE POLICY tenant_isolation ON support_messages
  USING (
    is_system() OR is_super_admin() OR EXISTS (
      SELECT 1 FROM support_tickets t
      WHERE t.id = support_messages.ticket_id
        AND t.transporter_id = current_company()
    )
  )
  WITH CHECK (
    is_system() OR is_super_admin() OR EXISTS (
      SELECT 1 FROM support_tickets t
      WHERE t.id = support_messages.ticket_id
        AND t.transporter_id = current_company()
    )
  );