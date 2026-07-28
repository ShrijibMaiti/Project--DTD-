-- Project DTD — system of record.
-- PII lives HERE (and in encrypted blob storage). The chain carries hashes only.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------- tenants
CREATE TABLE companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name      text NOT NULL,
  contact_phone   text NOT NULL,
  gstin           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  full_name       text NOT NULL,
  phone           text NOT NULL UNIQUE,
  role            text NOT NULL DEFAULT 'MEMBER',       -- OWNER | MEMBER | OPS
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- fleet
CREATE TABLE trucks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  reg_number      text NOT NULL UNIQUE,
  truck_type      text NOT NULL,
  capacity_kg     integer NOT NULL,
  gps_device_id   text,
  status          text NOT NULL DEFAULT 'AVAILABLE',    -- AVAILABLE|ON_TRIP|MAINTENANCE|INACTIVE
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE drivers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  full_name       text NOT NULL,
  phone           text NOT NULL UNIQUE,                 -- signing identity anchor
  license_number  text NOT NULL,
  signing_address text,                                 -- set on first key mint (Domain 2)
  status          text NOT NULL DEFAULT 'ACTIVE',       -- ACTIVE|SUSPENDED|INACTIVE
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- pricing
CREATE TABLE price_quotes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  truck_type           text NOT NULL,
  material_weight_kg   integer NOT NULL,
  distance_km          integer NOT NULL,
  estimated_price_inr  integer NOT NULL,
  range_low_inr        integer NOT NULL,
  range_high_inr       integer NOT NULL,
  final_price_inr      integer,
  confirmed_at         timestamptz,
  expires_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- bookings
CREATE TABLE bookings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  quote_id             uuid NOT NULL REFERENCES price_quotes(id),
  truck_type           text NOT NULL,
  material_weight_kg   integer NOT NULL,
  scheduled_at         timestamptz NOT NULL,             -- advance scheduling
  status               text NOT NULL DEFAULT 'CONFIRMED',
                       -- CONFIRMED|ASSIGNED|IN_TRANSIT|DELIVERED|CANCELLED
  estimated_price_inr  integer NOT NULL,
  truck_id             uuid REFERENCES trucks(id),
  driver_id            uuid REFERENCES drivers(id),
  trip_id              text,                             -- bytes32 hex, set at trip start
  manifest_id          text,                             -- bytes32 hex (Domain 3 custody)
  notes                text,
  cancel_reason        text,
  created_by           uuid REFERENCES users(id),
  assigned_at          timestamptz,
  cancelled_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE booking_stops (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind         text NOT NULL,                            -- PICKUP | DROP
  address      text NOT NULL,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  sequence     integer NOT NULL
);
CREATE INDEX booking_stops_booking_idx ON booking_stops (booking_id, sequence);

-- ---------------------------------------------------------------- kyc
CREATE TABLE kyc_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  doc_kind        text NOT NULL,
  storage_key     text NOT NULL,                         -- S3 key; PII never on-chain
  subject_type    text NOT NULL,                         -- TRANSPORTER|TRUCK|DRIVER
  subject_id      uuid NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING',       -- PENDING|VERIFIED|REJECTED
  review_note     text,
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kyc_subject_idx ON kyc_records (subject_type, subject_id);

-- ---------------------------------------------------------------- insurance
CREATE TABLE insurance_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  booking_id          uuid NOT NULL UNIQUE REFERENCES bookings(id),
  policy_number       text NOT NULL,
  declared_value_inr  integer NOT NULL CHECK (declared_value_inr <= 5000000),
  premium_inr         integer NOT NULL,
  status              text NOT NULL DEFAULT 'ACTIVE',    -- ACTIVE|CLAIMED|EXPIRED
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- payments
CREATE TABLE payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  booking_id        uuid NOT NULL REFERENCES bookings(id),
  amount_inr        integer NOT NULL,
  method            text NOT NULL,                       -- UPI|NEFT|IMPS|NETBANKING
  status            text NOT NULL DEFAULT 'PENDING',     -- PENDING|PAID|FAILED
  payout_status     text NOT NULL DEFAULT 'HELD',        -- HELD|RELEASED|SPLIT
  gateway_order_id  text UNIQUE,
  paid_at           timestamptz,
  payout_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_booking_idx ON payments (booking_id);

-- ---------------------------------------------------------------- documents
CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  booking_id      uuid NOT NULL REFERENCES bookings(id),
  doc_type        text NOT NULL,                         -- BILTY|POD|INVOICE|MANIFEST
  storage_key     text NOT NULL,
  doc_hash        text NOT NULL UNIQUE,                  -- keccak256 — mirrors chain
  chain_tx        text NOT NULL,
  status          text NOT NULL DEFAULT 'ANCHORED',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_booking_idx ON documents (booking_id);

-- ---------------------------------------------------------------- claims
CREATE TABLE claims_packets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  booking_id      uuid NOT NULL UNIQUE REFERENCES bookings(id),
  packet          jsonb NOT NULL,
  packet_hash     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- support
CREATE TABLE support_tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  booking_id      uuid REFERENCES bookings(id),
  category        text NOT NULL,
  subject         text NOT NULL,
  status          text NOT NULL DEFAULT 'OPEN',          -- OPEN|IN_PROGRESS|CLOSED
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id   uuid,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- audit (append-only)
CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  company_id  uuid,
  user_id         uuid,
  action          text NOT NULL,
  entity          text NOT NULL,
  entity_id       text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}',
  at              timestamptz NOT NULL DEFAULT now()
);
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;