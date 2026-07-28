/**
 * custody/manifest/cosign-links.ts
 * The adoption-critical piece: loader and driver co-sign "200 pieces" in
 * ~10 seconds via a WhatsApp link + OTP. No app install, no account, no wallet.
 *
 * Flow:
 *   1. issueLink(role) -> short-lived signed token -> WhatsApp message
 *   2. Party opens link -> sees "Confirm 200 pieces, Delhi -> Jaipur"
 *   3. Taps Confirm -> OTP to their phone -> submitSignature()
 *   4. SignerService signs the CONTRACT-DERIVED digest -> relayed on-chain
 *
 * The digest always comes from the contract (loadingDigest), never
 * constructed here — that's what makes signatures replay-safe by construction.
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Hex } from "viem";
import { getLoadingDigest, submitSignature } from "@dtd/chain-sdk/anchor";
import type { SignerService } from "@dtd/chain-sdk/keys/signer-service";
import type { ManifestStore } from "./builder";

export type CosignRole = "loader" | "driver";

export interface CosignToken {
  manifestId: string;
  role: CosignRole;
  phone: string;
  nonce: string;
  expiresAt: number;
}

export interface WhatsAppSender {
  send(phone: string, body: string): Promise<void>;
}

export interface OtpDispatcher {
  /** Sends an OTP and returns an opaque session token. */
  start(phone: string): Promise<{ otpSession: string }>;
}

export interface CosignAuditLog {
  record(e: {
    manifestId: string;
    role: CosignRole;
    phone: string;
    action: "LINK_ISSUED" | "LINK_OPENED" | "SIGNED" | "REJECTED";
    reason?: string;
    at: number;
  }): Promise<void>;
}

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6h — a loading window, not a day

export class CosignLinkService {
  constructor(
    private manifests: ManifestStore,
    private signer: SignerService,
    private whatsapp: WhatsAppSender,
    private otp: OtpDispatcher,
    private audit: CosignAuditLog,
    private secret = process.env.DTD_COSIGN_SECRET!,
    private baseUrl = process.env.APP_BASE_URL!
  ) {}

  // ---------------------------------------------------------------- issue

  async issueLink(params: {
    manifestId: string;
    role: CosignRole;
    phone: string;
  }): Promise<{ url: string; expiresAt: number }> {
    const manifest = await this.manifests.get(params.manifestId);
    if (!manifest) throw new Error("MANIFEST_NOT_FOUND");

    const token: CosignToken = {
      manifestId: params.manifestId,
      role: params.role,
      phone: params.phone,
      nonce: randomBytes(12).toString("hex"),
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    const encoded = this.encode(token);
    const url = `${this.baseUrl}/cosign/${encoded}`;

    const roleWord = params.role === "loader" ? "loading" : "pickup";
    await this.whatsapp.send(
      params.phone,
      `DTD: confirm ${manifest.pieceCount} pieces at ${roleWord}.\n` +
        `Tap to confirm (expires in 6 hours):\n${url}`
    );
    await this.audit.record({
      manifestId: params.manifestId,
      role: params.role,
      phone: params.phone,
      action: "LINK_ISSUED",
      at: Date.now(),
    });

    return { url, expiresAt: token.expiresAt };
  }

  // ---------------------------------------------------------------- open

  /** What the party sees before tapping Confirm. Read-only, no side effects. */
  async openLink(encoded: string) {
    const token = this.decode(encoded);
    const manifest = await this.manifests.get(token.manifestId);
    if (!manifest) throw new Error("MANIFEST_NOT_FOUND");

    await this.audit.record({
      manifestId: token.manifestId,
      role: token.role,
      phone: token.phone,
      action: "LINK_OPENED",
      at: Date.now(),
    });

    return {
      role: token.role,
      manifestId: manifest.manifestId,
      pieceCount: manifest.pieceCount,
      bookingId: manifest.bookingId,
      /** Masked for display: +91XXXXXX1234 */
      phoneMasked: token.phone.replace(/^(\+\d{2})\d{6}(\d{4})$/, "$1XXXXXX$2"),
      expiresAt: token.expiresAt,
    };
  }

  /** Step 1 of confirmation: fire the OTP. */
  async requestOtp(encoded: string): Promise<{ otpSession: string }> {
    const token = this.decode(encoded);
    await this.signer.ensureKey(token.phone); // idempotent key mint
    return this.otp.start(token.phone);
  }

  // ---------------------------------------------------------------- sign

  /**
   * Step 2: OTP verified inside signer.signDigest -> signature -> chain.
   * Note the digest is fetched from the contract, so a token that was
   * tampered with (different manifestId) produces a signature over a
   * DIFFERENT digest and the contract rejects it.
   */
  async submitConfirmation(params: {
    encoded: string;
    otpToken: string;
  }): Promise<{ manifestId: string; role: CosignRole; txHash: string }> {
    const token = this.decode(params.encoded);

    const digest = await getLoadingDigest(token.manifestId as Hex);
    let sig: Hex;
    try {
      sig = await this.signer.signDigest(token.phone, params.otpToken, digest);
    } catch (err) {
      await this.audit.record({
        manifestId: token.manifestId,
        role: token.role,
        phone: token.phone,
        action: "REJECTED",
        reason: (err as Error).message,
        at: Date.now(),
      });
      throw err;
    }

    const txHash = await submitSignature(token.role, token.manifestId as Hex, sig);

    await this.audit.record({
      manifestId: token.manifestId,
      role: token.role,
      phone: token.phone,
      action: "SIGNED",
      at: Date.now(),
    });

    return { manifestId: token.manifestId, role: token.role, txHash };
  }

  // ---------------------------------------------------------------- token codec

  private encode(t: CosignToken): string {
    const payload = Buffer.from(JSON.stringify(t)).toString("base64url");
    const sig = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${payload}.${sig}`;
  }

  private decode(encoded: string): CosignToken {
    const [payload, sig] = encoded.split(".");
    if (!payload || !sig) throw new Error("MALFORMED_TOKEN");

    const expected = createHmac("sha256", this.secret).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("BAD_TOKEN_SIGNATURE");
    }

    const token = JSON.parse(Buffer.from(payload, "base64url").toString()) as CosignToken;
    if (Date.now() > token.expiresAt) throw new Error("TOKEN_EXPIRED");
    return token;
  }
}