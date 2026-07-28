-- Company-scoped isolation, with a deliberate SuperAdmin escape hatch.
--
-- RLS answers "whose rows are these?"; RBAC answers "what may this user do
-- with them?". Neither substitutes for the other. This file is only the first.
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
ALTER TABLE companies       ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies       FORCE  ROW LEVEL SECURITY;
ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE users           FORCE  ROW LEVEL SECURITY;
ALTER TABLE invitations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations     FORCE  ROW LEVEL SECURITY;
ALTER TABLE join_requests   ENABLE ROW LEVEL SECURITY;
ALTER TABLE join_requests   FORCE  ROW LEVEL SECURITY;
ALTER TABLE subscriptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions   FORCE  ROW LEVEL SECURITY;
ALTER TABLE company_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_modules FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- policies
CREATE POLICY company_self ON companies
  USING (is_system() OR is_super_admin() OR id = current_company());

CREATE POLICY users_tenant ON users
  USING (is_system() OR is_super_admin() OR company_id = current_company());

CREATE POLICY invitations_tenant ON invitations
  USING (is_system() OR is_super_admin() OR company_id = current_company());

CREATE POLICY join_requests_tenant ON join_requests
  USING (is_system() OR is_super_admin() OR company_id = current_company());

CREATE POLICY subscriptions_tenant ON subscriptions
  USING (is_system() OR is_super_admin() OR company_id = current_company());

CREATE POLICY company_modules_tenant ON company_modules
  USING (is_system() OR is_super_admin() OR company_id = current_company());

-- Sessions belong to a user, and a user belongs to a company.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE  ROW LEVEL SECURITY;
CREATE POLICY sessions_tenant ON sessions
  USING (
    is_system() OR is_super_admin() OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = sessions.user_id AND u.company_id = current_company()
    )
  );

-- ---------------------------------------------------------------- write guards
/* Reading is company-scoped above; these stop a compromised session from
   writing rows into ANOTHER company even if it slipped past the app layer. */
CREATE POLICY users_insert_own_company ON users FOR INSERT
  WITH CHECK (is_system() OR is_super_admin() OR company_id = current_company());

CREATE POLICY invitations_insert_own_company ON invitations FOR INSERT
  WITH CHECK (is_system() OR is_super_admin() OR company_id = current_company());

/* Only the platform may change what a company pays for. A Company Admin
   reads these rows; he does not write them. */
CREATE POLICY subscriptions_platform_write ON subscriptions FOR ALL
  USING (is_system() OR is_super_admin())
  WITH CHECK (is_system() OR is_super_admin());

CREATE POLICY company_modules_platform_write ON company_modules FOR ALL
  USING (is_system() OR is_super_admin())
  WITH CHECK (is_system() OR is_super_admin());