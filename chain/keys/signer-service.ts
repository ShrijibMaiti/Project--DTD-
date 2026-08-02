/**
 * chain/keys/signer-service.ts
 * The invisible-wallet machinery. Each participant (loader, driver, shipper,
 * receiver) gets a keypair bound to their phone number. They never see it.
 * Signing = tapping "Confirm" after OTP; cryptography happens here.
 *
 * PRODUCTION NOTES:
 *  - MASTER_KEY must come from AWS KMS / Secrets Manager, never .env files.
 *  - OTP verification below is an interface — wire it to your existing
 *    WhatsApp/SMS OTP provider (MSG91, Twilio, etc.).
 *  - Every sign event is audit-logged (who, what digest, when, which OTP session).
 *  - exportKey() honors the self-sovereign promise: users can take their
 *    reputation key with them.
 */

import crypto from "crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex, Address } from "viem";

// ---------------------------------------------------------------- storage interface
// Back with Postgres in production (table: participant_keys).

export interface KeyRecord {
  phone: string;          // E.164, e.g. +91XXXXXXXXXX
  address: Address;       // public signing address (goes into contracts)
  encKey: string;         // AES-256-GCM ciphertext of the private key
  iv: string;
  authTag: string;
  createdAt: number;
  exportedAt: number | null;
}

export interface KeyStore {
  get(phone: string): Promise<KeyRecord | null>;
  put(rec: KeyRecord): Promise<void>;
  markExported(phone: string): Promise<void>;
}

export interface OtpVerifier {
  /** Returns true only for a fresh, unconsumed OTP session for this phone. */
  verify(phone: string, otpToken: string): Promise<boolean>;
}

export interface AuditLog {
  record(event: {
    phone: string;
    address: Address;
    digest: Hex;
    action: "KEY_CREATED" | "SIGNED" | "EXPORTED";
    at: number;
  }): Promise<void>;
}

// ---------------------------------------------------------------- crypto helpers

let _masterKey: Buffer | null = null;

/**
 * Derived on first use, not at import.
 *
 * Module-scope derivation meant importing this file at all required the env
 * var to be present — so a service that merely referenced SignerService's
 * TYPE would crash at load. Lazy derivation keeps the failure at the point
 * where a key is actually needed, and makes the message say what to do.
 */
function masterKey(): Buffer {
  if (_masterKey) return _masterKey;
  const raw = process.env.DTD_KEYS_MASTER_KEY;
  if (!raw) {
    throw new Error(
      "DTD_KEYS_MASTER_KEY is not set. In production this must come from " +
        "AWS KMS / Secrets Manager, never a .env file."
    );
  }
  if (process.env.NODE_ENV === "production" && raw.startsWith("test-")) {
    throw new Error("REFUSING_TEST_MASTER_KEY_IN_PRODUCTION");
  }
  _masterKey = crypto.createHash("sha256").update(raw).digest();
  return _masterKey;
}

function encrypt(plain: Hex): { encKey: string; iv: string; authTag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    encKey: enc.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function decrypt(rec: KeyRecord): Hex {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    masterKey(),
    Buffer.from(rec.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(rec.authTag, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(rec.encKey, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8") as Hex;
}

// ---------------------------------------------------------------- service

export class SignerService {
  constructor(
    private store: KeyStore,
    private otp: OtpVerifier,
    private audit: AuditLog
  ) {}

  /** Idempotent: returns the existing address or creates a fresh keypair. */
  async ensureKey(phone: string): Promise<Address> {
    const existing = await this.store.get(phone);
    if (existing) return existing.address;

    const priv = generatePrivateKey();
    const account = privateKeyToAccount(priv);
    const { encKey, iv, authTag } = encrypt(priv);

    const rec: KeyRecord = {
      phone,
      address: account.address,
      encKey,
      iv,
      authTag,
      createdAt: Date.now(),
      exportedAt: null,
    };
    await this.store.put(rec);
    await this.audit.record({
      phone,
      address: account.address,
      digest: "0x" as Hex,
      action: "KEY_CREATED",
      at: Date.now(),
    });
    return account.address;
  }

  /**
   * The core flow: user taps "Confirm 200 pieces" -> OTP verified ->
   * we sign the on-chain digest with their key -> platform relays sig.
   * Digest must come from the contract (loadingDigest / deliveryDigest /
   * attestationDigest) so signatures are replay-safe by construction.
   */
  async signDigest(phone: string, otpToken: string, digest: Hex): Promise<Hex> {
    const ok = await this.otp.verify(phone, otpToken);
    if (!ok) throw new Error("OTP_INVALID");

    const rec = await this.store.get(phone);
    if (!rec) throw new Error("KEY_NOT_FOUND");

    const account = privateKeyToAccount(decrypt(rec));
    // signMessage with { raw } applies the EIP-191 prefix — matches
    // the contracts' _ethSigned() exactly.
    const sig = await account.signMessage({ message: { raw: digest } });

    await this.audit.record({
      phone,
      address: rec.address,
      digest,
      action: "SIGNED",
      at: Date.now(),
    });
    return sig;
  }

  /**
   * Self-sovereignty escape hatch: the user may export their private key
   * (e.g. moving their reputation to another platform). OTP-gated,
   * audit-logged, and flagged so ops can watch for compromise.
   */
  async exportKey(phone: string, otpToken: string): Promise<Hex> {
    const ok = await this.otp.verify(phone, otpToken);
    if (!ok) throw new Error("OTP_INVALID");

    const rec = await this.store.get(phone);
    if (!rec) throw new Error("KEY_NOT_FOUND");

    await this.store.markExported(phone);
    await this.audit.record({
      phone,
      address: rec.address,
      digest: "0x" as Hex,
      action: "EXPORTED",
      at: Date.now(),
    });
    return decrypt(rec);
  }
}