-- Domain 7 — Identity, RBAC & Subscriptions.
-- Companies, users, roles, invitations, subscriptions, company_modules.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------- companies
CREATE TABLE companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_code    text NOT NULL UNIQUE,              -- shareable: DTD-7K2M9Q
  legal_name      text NOT NULL,
  gstin           text UNIQUE,
  contact_phone   text NOT NULL,
  contact_email   text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING',   -- PENDING|ACTIVE|SUSPENDED
  plan            text NOT NULL DEFAULT 'STARTER',
  approved_by     uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid REFERENCES companies(id),      -- NULL only for SUPER_ADMIN
  role           text NOT NULL,                       -- see shared/roles.schema.ts
  full_name      text NOT NULL,
  phone          text UNIQUE,
  email          text UNIQUE,
  password_hash  text,                                -- NULL for phone/OTP users
  signing_address text,                               -- Domain 2 key, minted on first sign
  status         text NOT NULL DEFAULT 'ACTIVE',      -- ACTIVE|SUSPENDED
  token_version  integer NOT NULL DEFAULT 1,          -- bump = invalidate live tokens
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_need_a_contact CHECK (phone IS NOT NULL OR email IS NOT NULL),
  -- The structural guarantee: only SUPER_ADMIN may be company-less.
  CONSTRAINT users_company_scope CHECK (
    (role = 'SUPER_ADMIN' AND company_id IS NULL) OR
    (role <> 'SUPER_ADMIN' AND company_id IS NOT NULL)
  )
);
CREATE INDEX users_company_idx ON users (company_id, role);

-- ---------------------------------------------------------------- sessions
CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token  text NOT NULL UNIQUE,
  device_label   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- invitations
CREATE TABLE invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  role             text NOT NULL,
  full_name        text NOT NULL,
  phone            text,
  email            text,
  invited_by       uuid NOT NULL REFERENCES users(id),
  status           text NOT NULL DEFAULT 'PENDING',   -- PENDING|ACCEPTED|REVOKED|EXPIRED
  accepted_user_id uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,

  CONSTRAINT invitations_need_a_contact CHECK (phone IS NOT NULL OR email IS NOT NULL),
  CONSTRAINT invitations_no_superadmin CHECK (role <> 'SUPER_ADMIN')
);
-- At most one live invite per contact per company.
CREATE UNIQUE INDEX invitations_pending_phone_idx
  ON invitations (company_id, phone) WHERE status = 'PENDING' AND phone IS NOT NULL;
CREATE UNIQUE INDEX invitations_pending_email_idx
  ON invitations (company_id, email) WHERE status = 'PENDING' AND email IS NOT NULL;

-- ---------------------------------------------------------------- join requests
CREATE TABLE join_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  full_name       text NOT NULL,
  phone           text NOT NULL,
  requested_role  text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING',    -- PENDING|APPROVED|REJECTED
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- A stranger with a company code may only ask to be a Driver or Receiver.
  CONSTRAINT join_requests_low_privilege CHECK (
    requested_role IN ('DRIVER', 'RECEIVER')
  )
);
CREATE UNIQUE INDEX join_requests_pending_idx
  ON join_requests (company_id, phone) WHERE status = 'PENDING';

-- ---------------------------------------------------------------- subscriptions
CREATE TABLE subscriptions (
  company_id               uuid PRIMARY KEY REFERENCES companies(id),
  plan                     text NOT NULL,
  status                   text NOT NULL DEFAULT 'ACTIVE',
                           -- TRIALING|ACTIVE|PAST_DUE|GRACE|DOWNGRADED|CANCELLED
  gateway_subscription_id  text UNIQUE,
  current_period_start     timestamptz NOT NULL DEFAULT now(),
  current_period_end       timestamptz NOT NULL,
  failed_attempts          integer NOT NULL DEFAULT 0,
  grace_ends_at            timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- module entitlements
CREATE TABLE company_modules (
  company_id   uuid NOT NULL REFERENCES companies(id),
  module       text NOT NULL,
  granted      boolean NOT NULL,                      -- false = explicitly revoked
  reason       text,
  set_by       uuid NOT NULL REFERENCES users(id),
  set_at       timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,                           -- trials auto-revoke
  PRIMARY KEY (company_id, module)
);
CREATE INDEX company_modules_expiry_idx
  ON company_modules (expires_at) WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------- audit (append-only)
CREATE TABLE identity_audit (
  id           bigserial PRIMARY KEY,
  actor_id     uuid,
  company_id   uuid,
  target_id    text,
  action       text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}',
  at           timestamptz NOT NULL DEFAULT now()
);
REVOKE UPDATE, DELETE ON identity_audit FROM PUBLIC;
CREATE INDEX identity_audit_company_idx ON identity_audit (company_id, at DESC);