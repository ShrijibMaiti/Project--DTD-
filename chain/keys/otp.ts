/**
 * chain/keys/otp.ts
 * OTP issuing and verification for SignerService.
 *
 * WHAT IS PRODUCTION-READY HERE: the challenge lifecycle. Codes are stored
 * only as salted hashes, are single-use, expire, cap attempts, and issuing a
 * new code invalidates the previous one. That logic is real.
 *
 * WHAT IS NOT: the delivery channel. OtpSender is an interface with a
 * ConsoleOtpSender implementation that logs the code. Wiring MSG91 / Twilio /
 * WhatsApp Business is a procurement task, not a coding one, and it is a
 * drop-in replacement — nothing else changes.
 *
 * ConsoleOtpSender REFUSES to run when NODE_ENV === "production". An OTP
 * system that silently degrades to "printed in the logs" is worse than no
 * OTP system, because everyone downstream assumes it works.
 */

import { createHash, randomInt, timingSafeEqual } from "crypto";
import type { PoolClient } from "pg";
import type { OtpVerifier } from "./signer-service";

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
const OTP_DIGITS = 6;

/** Delivery channel. Swap the implementation, change nothing else. */
export interface OtpSender {
  send(phone: string, code: string): Promise<void>;
}

export class ConsoleOtpSender implements OtpSender {
  async send(phone: string, code: string): Promise<void> {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "OTP_SENDER_NOT_CONFIGURED: ConsoleOtpSender must never run in production. " +
          "Wire a real provider before deploying."
      );
    }
    // eslint-disable-next-line no-console
    console.log(`[DEV OTP] ${phone} -> ${code}`);
  }
}

function hashCode(phone: string, code: string): string {
  // Phone is the salt: the same code for two numbers yields different hashes,
  // so a stolen table cannot be attacked with one precomputed rainbow set.
  return createHash("sha256").update(`${phone}:${code}`).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export class OtpService implements OtpVerifier {
  /**
   * @param client MUST be system-context — otp_challenges is system_only RLS.
   */
  constructor(private client: PoolClient, private sender: OtpSender) {}

  /**
   * Issue a fresh code. Any previous unconsumed challenge for this phone is
   * consumed first, so exactly one code is ever live — this is what stops an
   * attacker from farming multiple valid codes by spamming the endpoint.
   */
  async issue(phone: string): Promise<{ expiresAt: number }> {
    await this.client.query(
      `UPDATE otp_challenges SET consumed_at = now()
       WHERE phone = $1 AND consumed_at IS NULL`,
      [phone]
    );

    const code = String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, "0");
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await this.client.query(
      `INSERT INTO otp_challenges (phone, code_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [phone, hashCode(phone, code), expiresAt]
    );

    await this.sender.send(phone, code);
    return { expiresAt: expiresAt.getTime() };
  }

  /**
   * Verify and CONSUME. Returns false rather than throwing — SignerService
   * turns a false into OTP_INVALID, and callers must not be able to tell
   * "wrong code" from "no challenge" from "expired". All three look identical
   * to an attacker probing the endpoint.
   */
  async verify(phone: string, otpToken: string): Promise<boolean> {
    const { rows } = await this.client.query(
      `SELECT id, code_hash, attempts, expires_at
       FROM otp_challenges
       WHERE phone = $1 AND consumed_at IS NULL
       FOR UPDATE`,
      [phone]
    );
    const row = rows[0];
    if (!row) return false;

    if (new Date(row.expires_at).getTime() < Date.now()) {
      await this.client.query(
        `UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`,
        [row.id]
      );
      return false;
    }

    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      await this.client.query(
        `UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`,
        [row.id]
      );
      return false;
    }

    const ok = constantTimeEqual(row.code_hash, hashCode(phone, otpToken));

    if (!ok) {
      await this.client.query(
        `UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1`,
        [row.id]
      );
      return false;
    }

    await this.client.query(
      `UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`,
      [row.id]
    );
    return true;
  }
}

/**
 * Single-use, already-verified stand-in.
 *
 * Used when the OTP was checked in its own short transaction BEFORE the
 * caller opened a tenant transaction — see PreloadedKeyStore for the same
 * reasoning. Consuming the OTP separately is not a shortcut: it is the
 * correct behaviour, because a code that reached the server must be burned
 * even if the delivery that followed it failed.
 */
export class PreVerifiedOtp implements OtpVerifier {
  private used = false;
  constructor(private phone: string) {}

  async verify(phone: string, _otpToken: string): Promise<boolean> {
    if (this.used) return false;
    if (phone !== this.phone) return false;
    this.used = true;
    return true;
  }
}
