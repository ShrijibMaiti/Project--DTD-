/**
 * gps/signing/gateway-signer.ts
 * PHASE-1 TRUST BOUNDARY — stated honestly, in code and in the pitch.
 *
 * Off-the-shelf GPS trackers do not sign anything. So in Phase 1 the gateway
 * signs each ping on arrival. What this proves: the ping was received by DTD
 * at time T and has not been altered since. What it does NOT prove: that the
 * device actually reported it (a compromised gateway could fabricate).
 *
 * Phase 3 moves signing into device firmware / secure elements — see
 * firmware-roadmap.md. The signature envelope below is versioned precisely so
 * that migration does not invalidate historical anchors.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { canonicalPing, type AcceptedPing } from "../ingest/gateway";

export enum SignerTier {
  /** Phase 1: DTD's server vouches for receipt. */
  GATEWAY = 1,
  /** Phase 2: device MAC verified AND gateway-signed. */
  GATEWAY_VERIFIED_DEVICE = 2,
  /** Phase 3: device secure element signs; gateway only relays. */
  DEVICE_SECURE_ELEMENT = 3,
}

export interface SignedPing extends AcceptedPing {
  signerTier: SignerTier;
  signerAddress: string;
  gatewaySig: Hex;
}

export class GatewaySigner {
  private account;
  readonly tier: SignerTier;

  constructor(
    privateKey: Hex = process.env.DTD_GATEWAY_SIGNER_KEY! as Hex,
    tier: SignerTier = SignerTier.GATEWAY_VERIFIED_DEVICE
  ) {
    this.account = privateKeyToAccount(privateKey);
    this.tier = tier;
  }

  get address(): string {
    return this.account.address;
  }

  /**
   * Sign the canonical ping plus the receipt timestamp. Including receivedAt
   * is what makes backdating detectable: a fabricated "old" ping signed today
   * carries today's receipt time inside the signed payload.
   */
  async sign(ping: AcceptedPing): Promise<SignedPing> {
    const message = this.envelope(ping);
    const gatewaySig = await this.account.signMessage({ message });
    return {
      ...ping,
      signerTier: this.tier,
      signerAddress: this.account.address,
      gatewaySig,
    };
  }

  async signBatch(pings: AcceptedPing[]): Promise<SignedPing[]> {
    return Promise.all(pings.map((p) => this.sign(p)));
  }

  /** Verification for auditors — same envelope, recovered address must match. */
  envelope(ping: AcceptedPing): string {
    return [
      "DTDv1",
      this.tier,
      canonicalPing(ping),
      ping.tripId,
      ping.truckId,
      ping.receivedAt,
    ].join("|");
  }
}

/**
 * Honest disclosure string. Surfaced in evidence packets and the lender/insurer
 * portal so nobody is misled about what a Phase-1 anchor proves.
 */
export const TRUST_DISCLOSURE: Record<SignerTier, string> = {
  [SignerTier.GATEWAY]:
    "Signed by DTD's ingestion gateway on receipt. Proves the record is unaltered since receipt; does not independently prove device origin.",
  [SignerTier.GATEWAY_VERIFIED_DEVICE]:
    "Device authenticated by shared-secret MAC, then signed by DTD's gateway. Proves device authentication and integrity since receipt.",
  [SignerTier.DEVICE_SECURE_ELEMENT]:
    "Signed inside the device's secure element. Proves device origin independently of DTD's infrastructure.",
};