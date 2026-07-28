-- Tenant isolation for the Booking Platform Core, matching the conventions
-- in identity/db/rls-policies.sql exactly (same helper function shapes,
-- same two session variables). RLS answers "whose rows are these?"; RBAC
-- (identity/rbac/guards.ts) answers "what may this user do with them?".
-- Neither substitutes for the other.
--
-- IMPORTANT: the app MUST connect as a NOSUPERUSER NOBYPASSRLS role.
-- A superuser connection silently voids every policy below.

CREATE OR REPLACE FUNCTION current_company() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::uuid
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_role_name() RETURNS text AS $$
  SELECT COALESCE(NULLIF(current_setting('app.role', true), ''), '')
$$ LANGUAGE sql STABLE;

/* The escape hatch, named explicitly rather than hidden in a boolean. */
CREATE OR REPLACE FUNCTION is_super_admin() RETURNS boolean AS $$
  SELECT current_role_name() = 'SUPER_ADMIN'
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_system() RETURNS boolean AS $$
  SELECT current_role_name() = 'system'
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

-- ---------------------------------------------------------------- drop old policies
DROP POLICY IF EXISTS tenant_isolation ON trucks;
DROP POLICY IF EXISTS tenant_isolation ON drivers;
DROP POLICY IF EXISTS tenant_isolation ON price_quotes;
DROP POLICY IF EXISTS tenant_isolation ON bookings;
DROP POLICY IF EXISTS tenant_isolation ON kyc_records;
DROP POLICY IF EXISTS tenant_isolation ON insurance_policies;
DROP POLICY IF EXISTS tenant_isolation ON payments;
DROP POLICY IF EXISTS tenant_isolation ON documents;
DROP POLICY IF EXISTS tenant_isolation ON claims_packets;
DROP POLICY IF EXISTS tenant_isolation ON support_tickets;
DROP POLICY IF EXISTS tenant_isolation ON booking_stops;
DROP POLICY IF EXISTS tenant_isolation ON support_messages;

-- ---------------------------------------------------------------- policies
-- NOTE: transporter_id is the tenant column; it holds the SAME uuid as
-- companies.id. Migration B renames it to company_id.
CREATE POLICY tenant_isolation ON trucks
  USING (is_system() OR is_super_admin() OR transporter_id = current_company())
  WITH CHECK (is_system() OR is_super_admin() OR transporter_id = current_company());

CREATE POLICY tenant_isolation ON drivers
  USING (is_system() OR is_super_admin() OR transporter_id = current_company())
  WITH CHECK (is_system() OR is_super_admin() OR transporter_id = current_company());

CREATE POLICY tenant_isolation ON price_quotes
  USING (is_system() OR is_super_admin() OR transporter_id = current_company())
  WITH CHECK (is_system() OR is_super_admin() OR transporter_id = current_company());

CREATE POLICY tenant_isolation ON bookings
  USING (is_system() OR is_super_admin() OR transporter_id = current_company())
  WITH CHECK (is_system() OR is_super_admin() OR transporter_id = current_company());

CREATE POLICY tenant_isolation ON kyc_records
  USING (is_system() OR is_super_admin() OR transporter_id = current_company())
  WITH CHECK (is_system() OR is_super_admin() OR transporter_id = current_company());

CREATE POLICY tenant_isolation ON insurance_policies
  USING (is_system() OR is_super_admin() OR transporter_id = current_company())
  WITH CHECK (is_system() OR is_super_admin() OR transporter_id = current_company());

CREATE POLICY tenant_isolation ON payments
  USING (is_system() OR is_super_admin() OR transporter_id = current_company())
  WITH CHECK (is_system() OR is_super_admin() OR transporter_id = current_company());

CREATE POLICY tenant_isolation ON documents
  USING (is_system() OR is_super_admin() OR transporter_id = current_company())
  WITH CHECK (is_system() OR is_super_admin() OR transporter_id = current_company());

CREATE POLICY tenant_isolation ON claims_packets
  USING (is_system() OR is_super_admin() OR transporter_id = current_company())
  WITH CHECK (is_system() OR is_super_admin() OR transporter_id = current_company());

CREATE POLICY tenant_isolation ON support_tickets
  USING (is_system() OR is_super_admin() OR transporter_id = current_company())
  WITH CHECK (is_system() OR is_super_admin() OR transporter_id = current_company());

-- Child tables inherit isolation through their parent FK.
ALTER TABLE booking_stops    ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_stops    FORCE  ROW LEVEL SECURITY;
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

ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages FORCE  ROW LEVEL SECURITY;
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