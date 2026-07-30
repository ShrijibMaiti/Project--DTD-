-- Domain 4 — GPS Oracle Pipeline.
--
-- Tenancy: same tenant_ok() predicate as platform/identity/custody. Every
-- table carries company_id directly (denormalized), matching custody's
-- convention: RLS checks a column on the row itself, never a join.
--
-- KNOWN GAP (not fixed here — a service, not a store): PingBuffer.push()
-- persists AcceptedPing (unsigned). BatchStore/PingSource read SignedPing
-- (signed). GatewaySigner.sign() is the bridge between gps_pings_raw and
-- gps_pings below, and nothing in the repo currently calls it on a schedule.
-- That's a missing worker, analogous to workers/anchor-worker.ts but for
-- signing instead of anchoring — out of scope for a persistence-only session.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------- devices
CREATE TABLE gps_devices (
  device_id      text PRIMARY KEY,
  truck_id       uuid NOT NULL REFERENCES trucks(id),
  company_id     uuid NOT NULL REFERENCES companies(id),
  shared_secret  text NOT NULL,
  status         text NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE','SUSPENDED','RETIRED')),
  last_seen_ts   bigint,
  tamper_flags   integer NOT NULL DEFAULT 0,
  installed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gps_devices_truck_idx ON gps_devices (truck_id);
CREATE INDEX gps_devices_company_idx ON gps_devices (company_id);
-- Health sweep: devices silent while mid-trip. Partial on status to skip
-- retired devices, which are silent by definition and not interesting.
CREATE INDEX gps_devices_stale_idx ON gps_devices (last_seen_ts)
  WHERE status = 'ACTIVE';

-- ------------------------------------------------------ active bindings
-- One row per device. Binding history isn't part of the DeviceStore
-- contract (only activeBinding/bindTrip/unbindTrip exist) — no history
-- table, matching the interface exactly.
CREATE TABLE gps_device_bindings (
  device_id   text PRIMARY KEY REFERENCES gps_devices(device_id),
  company_id  uuid NOT NULL REFERENCES companies(id),
  trip_id     text CHECK (trip_id IS NULL OR trip_id ~ '^0x[0-9a-f]{64}$'),
  since       bigint NOT NULL
);
CREATE INDEX gps_device_bindings_trip_idx ON gps_device_bindings (trip_id)
  WHERE trip_id IS NOT NULL;

-- ------------------------------------------------------ raw ping staging
-- PingBuffer's target. Unsigned. See KNOWN GAP note above — a future
-- signing worker drains this into gps_pings below.
CREATE TABLE gps_pings_raw (
  id            bigserial PRIMARY KEY,
  device_id     text NOT NULL REFERENCES gps_devices(device_id),
  truck_id      uuid NOT NULL,
  trip_id       text NOT NULL CHECK (trip_id ~ '^0x[0-9a-f]{64}$'),
  company_id    uuid NOT NULL REFERENCES companies(id),
  lat           double precision NOT NULL,
  lng           double precision NOT NULL,
  ts            bigint NOT NULL,
  speed_kph     double precision,
  heading_deg   double precision,
  device_mac    text,
  received_at   bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gps_pings_raw_trip_idx ON gps_pings_raw (trip_id, ts);

-- --------------------------------------------------------- signed archive
-- BatchStore.drain() / PingSource read from here. Append-only in practice
-- (nothing in the interfaces ever updates or deletes a ping), but not
-- REVOKE-enforced like custody's scan_events — that table is a legal
-- evidence record by design; this one is telemetry, and the interfaces
-- don't imply the same guarantee. Not adding a restriction the domain
-- never asked for.
CREATE TABLE gps_pings (
  id             bigserial PRIMARY KEY,
  device_id      text NOT NULL REFERENCES gps_devices(device_id),
  truck_id       uuid NOT NULL,
  trip_id        text NOT NULL CHECK (trip_id ~ '^0x[0-9a-f]{64}$'),
  company_id     uuid NOT NULL REFERENCES companies(id),
  lat            double precision NOT NULL,
  lng            double precision NOT NULL,
  ts             bigint NOT NULL,
  speed_kph      double precision,
  received_at    bigint NOT NULL,
  signer_tier    smallint NOT NULL,
  signer_address text NOT NULL CHECK (signer_address ~ '^0x[0-9a-fA-F]{40}$'),
  gateway_sig    text NOT NULL
);
-- THE query shape: drain/pingsInWindow/batchPingsAt all filter by
-- (trip_id, ts range).
CREATE INDEX gps_pings_trip_ts_idx ON gps_pings (trip_id, ts);
CREATE INDEX gps_pings_company_idx ON gps_pings (company_id);

-- ---------------------------------------------------------------- batches
CREATE TABLE gps_batches (
  id           bigserial PRIMARY KEY,
  trip_id      text NOT NULL CHECK (trip_id ~ '^0x[0-9a-f]{64}$'),
  company_id   uuid NOT NULL REFERENCES companies(id),
  root         text NOT NULL CHECK (root ~ '^0x[0-9a-f]{64}$'),
  from_ts      bigint NOT NULL,
  to_ts        bigint NOT NULL CHECK (to_ts >= from_ts),
  ping_count   integer NOT NULL CHECK (ping_count > 0),
  -- NULL until anchored. markAnchored() targets the oldest NULL row for the
  -- trip — reproduces InMemoryBatchStore's find(batchIndex === null)
  -- first-match behavior from the fake exactly.
  batch_index  integer,
  chain_tx     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  anchored_at  timestamptz
);
CREATE INDEX gps_batches_trip_created_idx ON gps_batches (trip_id, created_at DESC);
CREATE INDEX gps_batches_unanchored_idx ON gps_batches (trip_id, created_at)
  WHERE batch_index IS NULL;
CREATE INDEX gps_batches_company_idx ON gps_batches (company_id);

-- ------------------------------------------------------------ device alerts
CREATE TABLE gps_device_alerts (
  id          bigserial PRIMARY KEY,
  device_id   text NOT NULL REFERENCES gps_devices(device_id),
  company_id  uuid NOT NULL REFERENCES companies(id),
  kind        text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('INFO','WARN','CRITICAL')),
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gps_device_alerts_device_idx ON gps_device_alerts (device_id, created_at DESC);
CREATE INDEX gps_device_alerts_company_idx ON gps_device_alerts (company_id, created_at DESC);

-- ------------------------------------------------------- ingest metrics
-- IngestMetrics.accepted/rejected. Append-only event log — same philosophy
-- as platform.audit_log (one row per event, no updates, analyzed by
-- aggregation rather than mutated counters).
CREATE TABLE gps_ingest_events (
  id             bigserial PRIMARY KEY,
  device_id      text NOT NULL,
  company_id     uuid,
  outcome        text NOT NULL CHECK (outcome IN ('ACCEPTED','REJECTED')),
  reject_reason  text,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gps_ingest_events_device_idx ON gps_ingest_events (device_id, at DESC);
REVOKE UPDATE, DELETE ON gps_ingest_events FROM PUBLIC;
REVOKE UPDATE, DELETE ON gps_ingest_events FROM dtd_app;

-- ---------------------------------------------------------------- RLS
ALTER TABLE gps_devices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE gps_devices          FORCE  ROW LEVEL SECURITY;
ALTER TABLE gps_device_bindings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE gps_device_bindings  FORCE  ROW LEVEL SECURITY;
ALTER TABLE gps_pings_raw        ENABLE ROW LEVEL SECURITY;
ALTER TABLE gps_pings_raw        FORCE  ROW LEVEL SECURITY;
ALTER TABLE gps_pings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE gps_pings            FORCE  ROW LEVEL SECURITY;
ALTER TABLE gps_batches          ENABLE ROW LEVEL SECURITY;
ALTER TABLE gps_batches          FORCE  ROW LEVEL SECURITY;
ALTER TABLE gps_device_alerts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE gps_device_alerts    FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON gps_devices;
DROP POLICY IF EXISTS tenant_isolation ON gps_device_bindings;
DROP POLICY IF EXISTS tenant_isolation ON gps_pings_raw;
DROP POLICY IF EXISTS tenant_isolation ON gps_pings;
DROP POLICY IF EXISTS tenant_isolation ON gps_batches;
DROP POLICY IF EXISTS tenant_isolation ON gps_device_alerts;

CREATE POLICY tenant_isolation ON gps_devices
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON gps_device_bindings
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON gps_pings_raw
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON gps_pings
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON gps_batches
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));
CREATE POLICY tenant_isolation ON gps_device_alerts
  USING (tenant_ok(company_id)) WITH CHECK (tenant_ok(company_id));