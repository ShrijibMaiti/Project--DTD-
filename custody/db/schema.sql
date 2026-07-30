-- Domain 3 — Custody & Scanning.
--
-- Tenancy: every table carries company_id and reuses the SAME tenant_ok()
-- predicate as platform/db/rls-policies.sql. One tenancy model across the
-- whole database — see identity/db/rls-policies.sql for the session vars.
--
-- The design rule that shapes this file: scan_events is APPEND-ONLY. A box's
-- history is a timeline, and timelines don't get edited. UPDATE and DELETE are
-- revoked at the table level, not merely discouraged in code.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------- manifests
CREATE TABLE manifests (
  -- The manifest id IS keccak256 of the canonical manifest. Storing it as the
  -- PK means a manifest cannot exist under an id that doesn't match its own
  -- contents — integrity by construction, not by trigger.
  manifest_id    text PRIMARY KEY CHECK (manifest_id ~ '^0x[0-9a-f]{64}$'),
  company_id     uuid NOT NULL REFERENCES companies(id),
  booking_id     uuid NOT NULL REFERENCES bookings(id),
  trip_id        text NOT NULL CHECK (trip_id ~ '^0x[0-9a-f]{64}$'),

  piece_count    integer NOT NULL CHECK (piece_count > 0),

  loader_address   text NOT NULL CHECK (loader_address ~ '^0x[0-9a-fA-F]{40}$'),
  driver_address   text NOT NULL CHECK (driver_address ~ '^0x[0-9a-fA-F]{40}$'),
  receiver_address text NOT NULL CHECK (receiver_address ~ '^0x[0-9a-fA-F]{40}$'),

  -- Full canonical document, for hash re-derivation during disputes.
  canonical_json text NOT NULL,
  chain_tx       text NOT NULL,

  created_at     timestamptz NOT NULL DEFAULT now()
);
-- One manifest per booking, enforced by the database rather than a service check.
CREATE UNIQUE INDEX manifests_booking_unique ON manifests (booking_id);
CREATE INDEX manifests_company_idx ON manifests (company_id, created_at DESC);
CREATE INDEX manifests_trip_idx ON manifests (trip_id);

-- ---------------------------------------------------------------- pieces
CREATE TABLE manifest_pieces (
  piece_id     text PRIMARY KEY CHECK (piece_id ~ '^DTD-[0-9A-HJ-NP-TV-Z]{10}$'),
  manifest_id  text NOT NULL REFERENCES manifests(manifest_id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id),
  sku          text,
  weight_kg    numeric(10,3) CHECK (weight_kg IS NULL OR weight_kg > 0),
  seq          integer NOT NULL
);
-- THE fork-detector index: piece_id -> manifest in one lookup, and globally
-- unique, so the same piece can never be minted into two shipments.
CREATE INDEX manifest_pieces_manifest_idx ON manifest_pieces (manifest_id, seq);
CREATE INDEX manifest_pieces_company_idx ON manifest_pieces (company_id);

-- ---------------------------------------------------------------- custody read model
-- The CHAIN is authoritative. This is a cache for fast queries, re-synced from
-- CustodyManifest.getManifest(). On divergence the chain wins and we alert.
CREATE TABLE custody_states (
  manifest_id      text PRIMARY KEY REFERENCES manifests(manifest_id) ON DELETE CASCADE,
  company_id       uuid NOT NULL REFERENCES companies(id),
  status           smallint NOT NULL,   -- mirrors CustodyManifest.Status
  piece_count      integer NOT NULL,
  delivered_count  integer NOT NULL DEFAULT 0,
  loader_signed    boolean NOT NULL DEFAULT false,
  driver_signed    boolean NOT NULL DEFAULT false,
  receiver_signed  boolean NOT NULL DEFAULT false,
  custody_start_at bigint,
  delivered_at     bigint,
  synced_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT delivered_never_exceeds_manifest
    CHECK (delivered_count <= piece_count)
);
CREATE INDEX custody_states_company_idx ON custody_states (company_id, status);

-- ---------------------------------------------------------------- scan events
-- APPEND-ONLY. See the REVOKE below — this is the double-scan net's memory,
-- and a memory that can be edited is worth nothing.
CREATE TABLE scan_events (
  scan_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_id      text NOT NULL,          -- deliberately NOT a FK: unknown/forged
                                        -- piece ids must still be recorded
  manifest_id   text REFERENCES manifests(manifest_id),
  company_id    uuid REFERENCES companies(id),   -- NULL for public scans
  context       text NOT NULL CHECK (
                  context IN ('LOADING','UNLOADING','PUBLIC_VERIFY','PARTNER')),
  scanner_id    text,
  location_hint text CHECK (location_hint IS NULL OR length(location_hint) <= 120),
  scanned_at    timestamptz NOT NULL,
  client_nonce  text,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

-- Idempotency for the offline scanner queue: a replayed flush is a no-op.
CREATE UNIQUE INDEX scan_events_nonce_unique
  ON scan_events (piece_id, client_nonce) WHERE client_nonce IS NOT NULL;

-- The three query shapes that matter, indexed deliberately:
CREATE INDEX scan_events_piece_idx ON scan_events (piece_id, scanned_at);        -- fork detector
CREATE INDEX scan_events_manifest_idx ON scan_events (manifest_id, context);     -- reconciliation
CREATE INDEX scan_events_recent_idx ON scan_events (recorded_at DESC);           -- sweeps

REVOKE UPDATE, DELETE ON scan_events FROM PUBLIC;
REVOKE UPDATE, DELETE ON scan_events FROM dtd_app;

-- ---------------------------------------------------------------- fork alerts
CREATE TABLE fork_alerts (
  id           bigserial PRIMARY KEY,
  piece_id     text NOT NULL,
  verdict      text NOT NULL CHECK (
                 verdict IN ('DUPLICATE_LIFE','POST_CLOSURE_SIGHTING',
                             'UNKNOWN_PIECE','NOT_ON_MANIFEST')),
  severity     text NOT NULL,
  manifest_id  text,
  company_id   uuid REFERENCES companies(id),
  detail       jsonb NOT NULL DEFAULT '{}',
  narrative    text,
  resolved_at  timestamptz,
  resolved_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fork_alerts_open_idx
  ON fork_alerts (company_id, created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX fork_alerts_piece_idx ON fork_alerts (piece_id);

-- ---------------------------------------------------------------- cosign tokens
CREATE TABLE cosign_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id  text NOT NULL REFERENCES manifests(manifest_id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id),
  role         text NOT NULL CHECK (role IN ('loader','driver','receiver')),
  phone        text NOT NULL,
  status       text NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','SIGNED','EXPIRED','REJECTED')),
  signed_at    timestamptz,
  chain_tx     text,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cosign_sessions_manifest_idx ON cosign_sessions (manifest_id, role);

-- ---------------------------------------------------------------- RLS
ALTER TABLE manifests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifests        FORCE  ROW LEVEL SECURITY;
ALTER TABLE manifest_pieces  ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifest_pieces  FORCE  ROW LEVEL SECURITY;
ALTER TABLE custody_states   ENABLE ROW LEVEL SECURITY;
ALTER TABLE custody_states   FORCE  ROW LEVEL SECURITY;
ALTER TABLE scan_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_events      FORCE  ROW LEVEL SECURITY;
ALTER TABLE fork_alerts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE fork_alerts      FORCE  ROW LEVEL SECURITY;
ALTER TABLE cosign_sessions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cosign_sessions  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON manifests;
DROP POLICY IF EXISTS tenant_isolation ON manifest_pieces;
DROP POLICY IF EXISTS tenant_isolation ON custody_states;
DROP POLICY IF EXISTS tenant_isolation ON scan_events;
DROP POLICY IF EXISTS tenant_isolation ON fork_alerts;
DROP POLICY IF EXISTS tenant_isolation ON cosign_sessions;

CREATE POLICY tenant_isolation ON manifests
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON manifest_pieces
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON custody_states
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON fork_alerts
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON cosign_sessions
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));

/*
 * scan_events is the exception, and deliberately so.
 *
 * The public verify page must be able to WRITE a scan for a piece belonging to
 * any company (that is the whole surveillance-net mechanism) while READING only
 * non-identifying data. So: writes are open to system context; reads are
 * tenant-scoped, with public scans (company_id IS NULL) readable by the
 * fork detector running as system.
 */
CREATE POLICY scan_read ON scan_events FOR SELECT
  USING (is_system() OR is_super_admin() OR company_id = current_company());
CREATE POLICY scan_write ON scan_events FOR INSERT
  WITH CHECK (is_system() OR tenant_ok(company_id));