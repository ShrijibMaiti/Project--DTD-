-- Migration 0003 — participant signing keys + OTP challenges.
--
-- WHY: chain/keys/signer-service.ts was written against three interfaces
-- (KeyStore, OtpVerifier, AuditLog) that never got concrete implementations,
-- and no table was ever created to hold key material. That is why
-- ReleaseGate.confirmAndSign() — the money seam — has never been callable.
--
-- SECURITY POSTURE, deliberately different from every other table here:
-- these rows are NOT tenant-scoped data, they are key material. A driver's
-- key follows the driver across companies; a receiver may belong to no
-- company at all. So instead of tenant_ok(), access is restricted to the
-- system context only. No company query can ever read a private key, even
-- its own employees'. Signing is a platform operation, not a tenant one.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM _migrations WHERE version = '0003_participant_keys') THEN
    RAISE EXCEPTION 'MIGRATION_ALREADY_APPLIED';
  END IF;
END $$;

-- ---------------------------------------------------------------- keys
CREATE TABLE participant_keys (
  phone        text PRIMARY KEY CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),

  -- Public signing address. Goes into CustodyManifest / ReputationLedger.
  address      text NOT NULL UNIQUE CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),

  -- AES-256-GCM ciphertext of the private key, produced by signer-service.
  -- The wrapping key lives in KMS, never in this database.
  enc_key      text NOT NULL,
  iv           text NOT NULL,
  auth_tag     text NOT NULL,

  -- Self-sovereignty: users may export their key and take their reputation
  -- elsewhere. Recorded so ops can watch for compromise patterns.
  exported_at  timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- otp
CREATE TABLE otp_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text NOT NULL,

  -- Only the hash is stored. A database dump must not yield live codes.
  code_hash     text NOT NULL,

  attempts      integer NOT NULL DEFAULT 0,
  consumed_at   timestamptz,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One live challenge per phone: issuing a new code invalidates the old one.
CREATE UNIQUE INDEX otp_challenges_live_idx
  ON otp_challenges (phone) WHERE consumed_at IS NULL;
CREATE INDEX otp_challenges_expiry_idx ON otp_challenges (expires_at);

-- ---------------------------------------------------------------- audit
CREATE TABLE signer_audit (
  id        bigserial PRIMARY KEY,
  phone     text NOT NULL,
  address   text,
  digest    text,
  action    text NOT NULL CHECK (action IN ('KEY_CREATED','SIGNED','EXPORTED')),
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signer_audit_phone_idx ON signer_audit (phone, at DESC);
REVOKE UPDATE, DELETE ON signer_audit FROM PUBLIC;

-- ---------------------------------------------------------------- RLS
ALTER TABLE participant_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE participant_keys FORCE  ROW LEVEL SECURITY;
ALTER TABLE otp_challenges   ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_challenges   FORCE  ROW LEVEL SECURITY;
ALTER TABLE signer_audit     ENABLE ROW LEVEL SECURITY;
ALTER TABLE signer_audit     FORCE  ROW LEVEL SECURITY;

-- is_system() ONLY. Note there is no is_super_admin() escape hatch here:
-- a platform administrator has no business reading private keys either.
CREATE POLICY system_only ON participant_keys
  USING (is_system()) WITH CHECK (is_system());
CREATE POLICY system_only ON otp_challenges
  USING (is_system()) WITH CHECK (is_system());
CREATE POLICY system_only ON signer_audit
  USING (is_system()) WITH CHECK (is_system());

-- The app role needs table privileges; RLS above is what actually gates it.
GRANT SELECT, INSERT, UPDATE ON participant_keys TO dtd_app;
GRANT SELECT, INSERT, UPDATE ON otp_challenges   TO dtd_app;
GRANT SELECT, INSERT          ON signer_audit    TO dtd_app;
GRANT USAGE, SELECT ON SEQUENCE signer_audit_id_seq TO dtd_app;

INSERT INTO _migrations (version) VALUES ('0003_participant_keys');

COMMIT;
