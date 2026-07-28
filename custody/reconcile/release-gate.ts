/**
 * custody/reconcile/release-gate.ts
 * THE MONEY SEAM. Nothing releases payment except this file, and this file
 * releases nothing unless scanned == manifest.
 *
 * Two-key design, deliberately redundant:
 *   1. Off-chain: reconcile says complete -> receiver signs the count ->
 *      CustodyManifest.confirmDelivery() sets Delivered.
 *   2. On-chain:  the platform's INR payout webhook re-checks
 *      CustodyManifest.isReleasable() directly from the chain.
 * A bug or compromise in this service still cannot free money the chain
 * disagrees with — and Escrow.sol enforces the same condition for on-chain funds.
 */

import { createHmac } from "crypto";
import type { Hex } from "viem";
import { CustodyStatus } from "@dtd/shared/manifest.schema";
import { confirmDelivery, getDeliveryDigest } from "@dtd/chain-sdk/anchor";
import { isReleasable } from "@dtd/chain-sdk/verify";
import type { SignerService } from "@dtd/chain-sdk/keys/signer-service";
import type { ReconcileCounter, ReconcileResult } from "./counter";
import type { HandoffService, AlertSink } from "../manifest/handoff";
import type { ManifestStore } from "../manifest/builder";

export interface ReleaseDecision {
  manifestId: string;
  releasable: boolean;
  reason:
    | "COMPLETE_SCAN_MATCH"
    | "SHORT_DELIVERY"
    | "OFF_MANIFEST_PIECES"
    | "NOT_YET_CONFIRMED"
    | "DISPUTED"
    | "CHAIN_DISAGREES";
  reconcile: ReconcileResult;
  chainStatus: CustodyStatus;
}

export class ReleaseGate {
  constructor(
    private counter: ReconcileCounter,
    private handoff: HandoffService,
    private manifests: ManifestStore,
    private signer: SignerService,
    private alerts: AlertSink,
    private platformWebhookUrl = process.env.DTD_PLATFORM_WEBHOOK_URL!,
    private internalSecret = process.env.DTD_INTERNAL_WEBHOOK_SECRET!
  ) {}

  /**
   * Step 1 — receiver finishes scanning and signs the count they actually got.
   * We submit the TRUE scanned count, never the expected one. If it's short,
   * the chain records Short and money freezes. That honesty is the product.
   */
  async confirmAndSign(params: {
    manifestId: string;
    receiverPhone: string;
    otpToken: string;
  }): Promise<ReleaseDecision> {
    const rec = await this.counter.reconcile(params.manifestId);

    const digest = await getDeliveryDigest(params.manifestId as Hex, rec.scanned);
    const sig = await this.signer.signDigest(
      params.receiverPhone,
      params.otpToken,
      digest
    );
    await confirmDelivery(params.manifestId as Hex, rec.scanned, sig);

    if (rec.offManifestPieceIds.length > 0) {
      await this.alerts.raise({
        kind: "OFF_MANIFEST_PIECES_AT_UNLOADING",
        manifestId: params.manifestId,
        detail: { pieceIds: rec.offManifestPieceIds },
        severity: "CRITICAL", // possible cloned labels — investigate now
      });
    }
    if (rec.missing > 0) {
      const attribution = await this.handoff.attributeLoss(params.manifestId);
      await this.alerts.raise({
        kind: "SHORT_DELIVERY",
        manifestId: params.manifestId,
        detail: {
          missing: rec.missing,
          missingPieceIds: rec.missingPieceIds,
          narrative: attribution.narrative,
          liableRole: attribution.liableRole,
        },
        severity: "CRITICAL",
      });
    }

    return this.evaluate(params.manifestId);
  }

  /** Step 2 — the decision. Chain is the final authority. */
  async evaluate(manifestId: string): Promise<ReleaseDecision> {
    const rec = await this.counter.reconcile(manifestId);
    const custody = await this.handoff.sync(manifestId);
    const chainSaysOk = await isReleasable(manifestId as Hex);

    let reason: ReleaseDecision["reason"];
    if (custody.status === CustodyStatus.Disputed) reason = "DISPUTED";
    else if (custody.status === CustodyStatus.InCustody) reason = "NOT_YET_CONFIRMED";
    else if (rec.extra > 0) reason = "OFF_MANIFEST_PIECES";
    else if (rec.missing > 0) reason = "SHORT_DELIVERY";
    else if (!chainSaysOk) reason = "CHAIN_DISAGREES";
    else reason = "COMPLETE_SCAN_MATCH";

    // Off-chain and on-chain views must agree. If they don't, something is
    // badly wrong (edited DB, failed tx) — freeze and shout.
    const offChainSaysOk = rec.complete && custody.status === CustodyStatus.Delivered;
    if (offChainSaysOk !== chainSaysOk) {
      await this.alerts.raise({
        kind: "RELEASE_GATE_DIVERGENCE",
        manifestId,
        detail: { offChainSaysOk, chainSaysOk, reconcile: rec },
        severity: "CRITICAL",
      });
    }

    return {
      manifestId,
      releasable: chainSaysOk && offChainSaysOk,
      reason,
      reconcile: rec,
      chainStatus: custody.status,
    };
  }

  /** Step 3 — notify the platform's INR payout webhook. It re-verifies too. */
  async requestPayout(manifestId: string): Promise<{ released: boolean; reason: string }> {
    const decision = await this.evaluate(manifestId);
    if (!decision.releasable) {
      return { released: false, reason: decision.reason };
    }

    const manifest = await this.manifests.get(manifestId);
    if (!manifest) throw new Error("MANIFEST_NOT_FOUND");

    const body = {
      manifestId,
      bookingId: manifest.bookingId,
      transporterId: manifest.transporterId,
    };
    const signature = createHmac("sha256", this.internalSecret)
      .update(JSON.stringify(body))
      .digest("hex");

    const res = await fetch(this.platformWebhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dtd-internal-signature": signature,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      return { released: false, reason: `PLATFORM_REJECTED_${res.status}` };
    }
    return { released: true, reason: decision.reason };
  }
}