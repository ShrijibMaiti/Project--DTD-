BEGIN;
SELECT set_config('app.company_id', '11111111-1111-1111-1111-111111111111', true);
SELECT set_config('app.actor_role', 'COMPANY_ADMIN', true);
SELECT set_config('app.is_system', 'false', true);
SELECT
  current_setting('app.company_id', true) AS raw_company,
  current_company()                        AS parsed_company,
  current_actor_role()                     AS role,
  is_system()                              AS sys,
  is_super_admin()                         AS sa,
  tenant_ok('11111111-1111-1111-1111-111111111111'::uuid) AS should_be_true,
  tenant_ok('22222222-2222-2222-2222-222222222222'::uuid) AS should_be_false;
COMMIT;
