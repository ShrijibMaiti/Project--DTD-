/**
 * custody/doublescan/verify-page-api.ts
 * The public "verify this box" endpoint — GET /v/:pieceId.
 *
 * Strategic purpose: every trader, retailer, and customer who scans a box
 * becomes a free sensor in the double-scan net. The more scans, the tighter.
 *
 * Privacy discipline (DPDP): the public response NEVER exposes routes,
 * addresses, phone numbers, party identities, or precise coordinates. It
 * answers exactly one question — "is this box genuine and where is it in
 * its life?" — while silently feeding the fork detector.
 */

import { ScanContext, ForkVerdict } from "@dtd/shared/scan-event.schema";
import { CustodyStatus } from "@dtd/shared/manifest.schema";
import type { LifecycleIndex } from "./lifecycle-index";
import type { ForkDetector } from "./fork-detector";
import type { ManifestStore } from "../manifest/builder";
import type { HandoffService } from "../manifest/handoff";
import { isWellFormedPieceId } from "../qr/generator";

export type PublicStatus =
  | "GENUINE_IN_TRANSIT"
  | "GENUINE_DELIVERED"
  | "FLAGGED"
  | "UNKNOWN";

export interface PublicVerifyResponse {
  pieceId: string;
  status: PublicStatus;
  headline: string;
  detail: string;
  /** Coarse only: month-level, no exact timestamps of private shipments. */
  firstSeen: string | null;
  scanCount: number;
  reportUrl?: string;
}

export interface RateLimiter {
  /** Returns false when the caller is over limit. */
  allow(key: string): Promise<boolean>;
}

export class VerifyPageApi {
  constructor(
    private lifecycle: LifecycleIndex,
    private forks: ForkDetector,
    private manifests: ManifestStore,
    private handoff: HandoffService,
    private limiter: RateLimiter
  ) {}

  /**
   * Public entry point. `ipKey` is a hashed IP for rate limiting —
   * we never store the raw IP.
   */
  async verify(params: {
    pieceId: string;
    ipKey: string;
    locationHint?: string | null;
    partnerId?: string | null;
  }): Promise<PublicVerifyResponse> {
    const pieceId = params.pieceId.trim().toUpperCase();

    if (!isWellFormedPieceId(pieceId)) {
      return {
        pieceId,
        status: "UNKNOWN",
        headline: "Not a DTD code",
        detail: "This code isn't in the DTD format. Check for a typo.",
        firstSeen: null,
        scanCount: 0,
      };
    }

    if (!(await this.limiter.allow(params.ipKey))) {
      throw new Error("RATE_LIMITED");
    }

    // Record FIRST — the scan is the point, even if the piece turns out fake.
    await this.lifecycle.record({
      pieceId,
      manifestId: null,
      context: params.partnerId ? ScanContext.PARTNER : ScanContext.PUBLIC_VERIFY,
      scannerId: params.partnerId ?? null,
      locationHint: this.coarsen(params.locationHint),
    });

    const analysis = await this.forks.analyze(pieceId);
    const history = await this.lifecycle.history(pieceId);
    const homeManifestId = await this.manifests.findManifestByPiece(pieceId);

    if (analysis.verdict === ForkVerdict.UNKNOWN_PIECE || !homeManifestId) {
      return {
        pieceId,
        status: "UNKNOWN",
        headline: "⚠ No record of this code",
        detail:
          "This code was never issued by DTD. If it's printed on a product " +
          "you bought, treat it as suspect and report it.",
        firstSeen: null,
        scanCount: history.length,
        reportUrl: `/report/${pieceId}`,
      };
    }

    if (analysis.verdict !== ForkVerdict.CLEAN) {
      return {
        pieceId,
        status: "FLAGGED",
        headline: "⚠ This code has been flagged",
        detail:
          "This code appears on more than one shipment record, which usually " +
          "means a copied label. DTD has been alerted and is investigating. " +
          "Please report where you found it.",
        firstSeen: this.coarseDate(history[0]?.scannedAt),
        scanCount: history.length,
        reportUrl: `/report/${pieceId}`,
      };
    }

    const custody = await this.handoff.sync(homeManifestId);
    const delivered =
      custody.status === CustodyStatus.Delivered ||
      custody.status === CustodyStatus.Short;

    return {
      pieceId,
      status: delivered ? "GENUINE_DELIVERED" : "GENUINE_IN_TRANSIT",
      headline: delivered ? "✅ Genuine — delivered" : "✅ Genuine — in transit",
      detail: delivered
        ? "This is a genuine DTD-tracked item and its delivery is recorded on-chain."
        : "This is a genuine DTD-tracked item currently in transit.",
      firstSeen: this.coarseDate(history[0]?.scannedAt),
      scanCount: history.length,
    };
  }

  /** Public reports feed investigations without exposing anything. */
  async report(params: {
    pieceId: string;
    note: string;
    contact?: string;
    ipKey: string;
  }): Promise<{ received: true }> {
    if (!(await this.limiter.allow(params.ipKey))) throw new Error("RATE_LIMITED");
    await this.lifecycle.record({
      pieceId: params.pieceId.trim().toUpperCase(),
      manifestId: null,
      context: ScanContext.PUBLIC_VERIFY,
      scannerId: null,
      locationHint: params.note.slice(0, 120),
    });
    return { received: true };
  }

  // ---------------------------------------------------------------- privacy

  /** City-level at most; drop anything that looks like a precise coordinate. */
  private coarsen(hint?: string | null): string | null {
    if (!hint) return null;
    if (/-?\d+\.\d{3,}/.test(hint)) return null;
    return hint.slice(0, 120);
  }

  /** Month granularity — never leak exact shipment timing publicly. */
  private coarseDate(iso?: string): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    return `${d.toLocaleString("en-IN", { month: "long" })} ${d.getFullYear()}`;
  }
}