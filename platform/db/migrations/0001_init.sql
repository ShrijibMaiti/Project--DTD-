-- Migration 0001 — initial schema + RLS.
-- Runner: run files in lexical order inside a transaction; record in _migrations.

BEGIN;

CREATE TABLE IF NOT EXISTS _migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Guard: skip if already applied.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM _migrations WHERE version = '0001_init') THEN
    RAISE EXCEPTION 'MIGRATION_ALREADY_APPLIED';
  END IF;
END $$;

\i schema.sql
\i rls-policies.sql

INSERT INTO _migrations (version) VALUES ('0001_init');

COMMIT;