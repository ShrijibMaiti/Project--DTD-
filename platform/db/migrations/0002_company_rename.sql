-- Migration 0002 — collapse `transporters` into `companies`, rename the
-- tenant column across all 11 tables.
--
-- WHY: Domain 7 owns `companies` (with plan, status, company_code, invitations
-- FKs). Domain 1 owned `transporters`. They are the same concept, and keeping
-- both meant two sources of truth for "who is the tenant" with nothing but
-- convention holding their ids equal.
--
-- SAFETY: one transaction. Either the whole rename lands or none of it does.
-- Run against a database with the 14 e2e tests as the verification gate.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM _migrations WHERE version = '0002_company_rename') THEN
    RAISE EXCEPTION 'MIGRATION_ALREADY_APPLIED';
  END IF;
END $$;

-- ---------------------------------------------------------------- 1. drop policies
-- Policies reference transporter_id by name; they must go before the rename.
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

-- ---------------------------------------------------------------- 2. the table
ALTER TABLE transporters RENAME TO companies;

-- Adopt the columns Domain 7 expects. Defaults chosen so existing rows stay
-- valid: an already-onboarded transporter is an ACTIVE company.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS company_code text,
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'STARTER',
  ADD COLUMN IF NOT EXISTS approved_by uuid;

-- Backfill codes for pre-existing rows (Crockford-ish, no I/L/O/U).
UPDATE companies
SET company_code = 'DTD-' || upper(
      translate(substr(encode(gen_random_bytes(6), 'base64'), 1, 6),
                'ilou+/=', 'XYZW234')
    )
WHERE company_code IS NULL;

UPDATE companies
SET contact_email = 'owner+' || left(id::text, 8) || '@placeholder.invalid'
WHERE contact_email IS NULL;

ALTER TABLE companies
  ALTER COLUMN company_code SET NOT NULL,
  ALTER COLUMN contact_email SET NOT NULL;

ALTER TABLE companies ADD CONSTRAINT companies_code_unique UNIQUE (company_code);

-- ---------------------------------------------------------------- 3. the columns
ALTER TABLE users              RENAME COLUMN transporter_id TO company_id;
ALTER TABLE trucks             RENAME COLUMN transporter_id TO company_id;
ALTER TABLE drivers            RENAME COLUMN transporter_id TO company_id;
ALTER TABLE price_quotes       RENAME COLUMN transporter_id TO company_id;
ALTER TABLE bookings           RENAME COLUMN transporter_id TO company_id;
ALTER TABLE kyc_records        RENAME COLUMN transporter_id TO company_id;
ALTER TABLE insurance_policies RENAME COLUMN transporter_id TO company_id;
ALTER TABLE payments           RENAME COLUMN transporter_id TO company_id;
ALTER TABLE documents          RENAME COLUMN transporter_id TO company_id;
ALTER TABLE claims_packets     RENAME COLUMN transporter_id TO company_id;
ALTER TABLE support_tickets    RENAME COLUMN transporter_id TO company_id;
ALTER TABLE audit_log          RENAME COLUMN transporter_id TO company_id;

-- ---------------------------------------------------------------- 4. indexes
ALTER INDEX IF EXISTS users_transporter_idx RENAME TO users_company_idx;

-- ---------------------------------------------------------------- 5. Domain 7 columns on users
-- users existed in both schemas; unify on Domain 7's shape.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS signing_address text,
  ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 1;

-- Platform seeded role='OWNER'; Domain 7's vocabulary is COMPANY_ADMIN.
UPDATE users SET role = 'COMPANY_ADMIN' WHERE role IN ('OWNER', 'MEMBER');
UPDATE users SET role = 'DISPATCHER'    WHERE role = 'OPS';

-- Only SUPER_ADMIN may be company-less; everyone else must have a tenant.
ALTER TABLE users ADD CONSTRAINT users_company_scope CHECK (
  (role = 'SUPER_ADMIN' AND company_id IS NULL) OR
  (role <> 'SUPER_ADMIN' AND company_id IS NOT NULL)
);

-- ---------------------------------------------------------------- 6. recreate policies
CREATE POLICY tenant_isolation ON trucks
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON drivers
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON price_quotes
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON bookings
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON kyc_records
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON insurance_policies
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON payments
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON documents
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON claims_packets
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON support_tickets
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));

CREATE POLICY tenant_isolation ON booking_stops
  USING (
    is_system() OR is_super_admin() OR EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.id = booking_stops.booking_id AND b.company_id = current_company()
    )
  )
  WITH CHECK (
    is_system() OR is_super_admin() OR EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.id = booking_stops.booking_id AND b.company_id = current_company()
    )
  );

CREATE POLICY tenant_isolation ON support_messages
  USING (
    is_system() OR is_super_admin() OR EXISTS (
      SELECT 1 FROM support_tickets t
      WHERE t.id = support_messages.ticket_id AND t.company_id = current_company()
    )
  )
  WITH CHECK (
    is_system() OR is_super_admin() OR EXISTS (
      SELECT 1 FROM support_tickets t
      WHERE t.id = support_messages.ticket_id AND t.company_id = current_company()
    )
  );

-- ---------------------------------------------------------------- 7. company RLS
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_self ON companies;
CREATE POLICY company_self ON companies
  USING (is_system() OR is_super_admin() OR id = current_company())
  WITH CHECK (is_system() OR is_super_admin());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_tenant ON users;
CREATE POLICY users_tenant ON users
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));

INSERT INTO _migrations (version) VALUES ('0002_company_rename');

COMMIT;