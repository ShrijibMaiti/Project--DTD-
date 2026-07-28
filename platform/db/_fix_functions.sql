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

CREATE OR REPLACE FUNCTION tenant_ok(row_tenant uuid) RETURNS boolean AS $$
  SELECT is_system() OR is_super_admin() OR row_tenant = current_company()
$$ LANGUAGE sql STABLE;
