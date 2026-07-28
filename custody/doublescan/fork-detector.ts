/**
 * custody/doublescan/fork-detector.ts
 * THE PRIMARY ANTI-THEFT ENGINE.
 *
 * Premise borrowed from Bitcoin's double-spend problem: a piece ID should
 * live exactly one life. Cloning creates duplicates, and an immutable log
 * is very good at spotting duplicates.
 *
 * Three detections:
 *   UNKNOWN_PIECE          - fabricated QR; ID exists in no manifest
 *   NOT_ON_MANIFEST        - real ID, wrong shipment (clone slipped into a load)
 *   DUPLICATE_LIFE         - same ID active in two custody chains simultaneously
 *   POST_CLOSURE_SIGHTING  - scanned alive after its chain closed -> the stolen
 *                            original surfacing in the grey market
 *
 * Detection is only half the job. Every verdict carries ATTRIBUTION: which
 * signed custody window the timeline forked inside.
 */

import {
  ForkVerdict,
  ScanContext,
  type ScanEvent,
} from "@dtd/shared/scan-event.schema";
import { CustodyStatus } from "@dtd/shared/manifest.schema";
import type { ManifestStore } from "../manifest/builder";
import type { LifecycleIndex } from "./lifecycle-index";
import type { HandoffService, AlertSink } from "../manifest/handoff";

export interface ForkAnalysis {
  pieceId: string;
  verdict: ForkVerdict;
  severity: "INFO" | "WARN" | "CRITICAL";
  /** Manifests this piece has legitimately or illegitimately appeared in. */
  manifestIds: string[];
  timeline: Array<{
    at: string;
    context: ScanContext;
    manifestId: string | null;
    where: string | null;
  }>;
  attribution: {
    forkedInsideManifest: string | null;
    custodyWindow: string | null;
    liableRole: "LOADER" | "DRIVER" | "RECEIVER" | "UNDETERMINED";
    narrative: string;
  } | null;
}

export class ForkDetector {
  constructor(
    private lifecycle: LifecycleIndex,
    private manifests: ManifestStore,
    private handoff: HandoffService,
    private alerts: AlertSink
  ) {}

  /**
   * Called on EVERY scan, from every source. Cheap: one piece-history read
   * plus one manifest lookup.
   */
  async analyze(pieceId: string): Promise<ForkAnalysis> {
    const history = await this.lifecycle.history(pieceId);
    const homeManifestId = await this.manifests.findManifestByPiece(pieceId);

    const timeline = history
      .slice()
      .sort((a, b) => a.scannedAt.localeCompare(b.scannedAt))
      .map((e) => ({
        at: e.scannedAt,
        context: e.context,
        manifestId: e.manifestId,
        where: e.locationHint,
      }));

    const manifestIds = [
      ...new Set(history.map((e) => e.manifestId).filter((m): m is string => !!m)),
    ];

    // ---- 1. Fabricated QR: this ID was never minted by us.
    if (!homeManifestId) {
      return this.finish({
        pieceId,
        verdict: ForkVerdict.UNKNOWN_PIECE,
        severity: "CRITICAL",
        manifestIds,
        timeline,
        attribution: null,
      });
    }

    // ---- 2. Real ID scanned under a manifest it doesn't belong to.
    const foreign = history.filter(
      (e) =>
        e.manifestId !== null &&
        e.manifestId !== homeManifestId &&
        (e.context === ScanContext.UNLOADING || e.context === ScanContext.LOADING)
    );
    if (foreign.length > 0) {
      return this.finish({
        pieceId,
        verdict: ForkVerdict.NOT_ON_MANIFEST,
        severity: "CRITICAL",
        manifestIds,
        timeline,
        attribution: await this.attribute(homeManifestId, pieceId),
      });
    }

    // ---- 3. Two live custody chains at once -> a clone exists somewhere.
    const activeManifests = await this.activeAmong(manifestIds);
    if (activeManifests.length > 1) {
      return this.finish({
        pieceId,
        verdict: ForkVerdict.DUPLICATE_LIFE,
        severity: "CRITICAL",
        manifestIds,
        timeline,
        attribution: await this.attribute(homeManifestId, pieceId),
      });
    }

    // ---- 4. Alive after its chain closed -> the stolen original resurfacing.
    const home = await this.handoff.sync(homeManifestId);
    const closed =
      home.status === CustodyStatus.Delivered ||
      home.status === CustodyStatus.Short;

    if (closed && home.deliveredAt) {
      const closedAtMs = home.deliveredAt * 1000;
      const afterClosure = history.filter(
        (e) =>
          new Date(e.scannedAt).getTime() > closedAtMs + 60_000 && // 1 min grace
          (e.context === ScanContext.PUBLIC_VERIFY || e.context === ScanContext.PARTNER)
      );

      // A piece recorded MISSING at delivery that later shows up alive is the
      // strongest possible theft signal.
      const wasMissing = await this.wasMissingAtDelivery(homeManifestId, pieceId);

      if (afterClosure.length > 0 && wasMissing) {
        return this.finish({
          pieceId,
          verdict: ForkVerdict.POST_CLOSURE_SIGHTING,
          severity: "CRITICAL",
          manifestIds,
          timeline,
          attribution: await this.attribute(homeManifestId, pieceId),
        });
      }
    }

    return this.finish({
      pieceId,
      verdict: ForkVerdict.CLEAN,
      severity: "INFO",
      manifestIds,
      timeline,
      attribution: null,
    });
  }

  /** Sweep — run nightly across recently active pieces. */
  async sweep(pieceIds: string[]): Promise<ForkAnalysis[]> {
    const out: ForkAnalysis[] = [];
    for (const id of pieceIds) {
      const a = await this.analyze(id);
      if (a.verdict !== ForkVerdict.CLEAN) out.push(a);
    }
    return out;
  }

  // ---------------------------------------------------------------- internals

  private async activeAmong(manifestIds: string[]): Promise<string[]> {
    const active: string[] = [];
    for (const id of manifestIds) {
      const rec = await this.handoff.sync(id);
      if (rec.status === CustodyStatus.InCustody) active.push(id);
    }
    return active;
  }

  private async wasMissingAtDelivery(manifestId: string, pieceId: string) {
    const scanned = await this.lifecycle.distinctPiecesScanned(
      manifestId,
      ScanContext.UNLOADING
    );
    return !scanned.includes(pieceId);
  }

  private async attribute(manifestId: string, pieceId: string) {
    const loss = await this.handoff.attributeLoss(manifestId);
    const manifest = await this.manifests.get(manifestId);
    return {
      forkedInsideManifest: manifestId,
      custodyWindow: loss.window,
      liableRole: loss.liableRole,
      narrative:
        `Piece ${pieceId} (booking ${manifest?.bookingId ?? "?"}) shows an ` +
        `impossible timeline. ${loss.narrative}`,
    };
  }

  private async finish(a: ForkAnalysis): Promise<ForkAnalysis> {
    if (a.verdict !== ForkVerdict.CLEAN) {
      await this.alerts.raise({
        kind: `FORK_${a.verdict}`,
        manifestId: a.attribution?.forkedInsideManifest ?? "unknown",
        detail: {
          pieceId: a.pieceId,
          verdict: a.verdict,
          manifestIds: a.manifestIds,
          timeline: a.timeline,
          narrative: a.attribution?.narrative,
        },
        severity: a.severity,
      });
    }
    return a;
  }
}