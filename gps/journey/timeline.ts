/**
 * gps/journey/timeline.ts
 * The human-readable journey record: start, end, route, every stop, durations.
 *
 * One pipeline, two products — which is why GPS tracking sits in Starter while
 * its anchoring sits in Enterprise. The timeline below is identical either way;
 * only the `verification` block changes.
 */

import type { SignedPing } from "../signing/gateway-signer";
import { TRUST_DISCLOSURE, type SignerTier } from "../signing/gateway-signer";
import { StopDetector, StopKind, haversineM, type Stop, type StopDetectorOptions } from "./stop-detector";
import { MerkleBatcher } from "../batching/merkle-batcher";

export interface JourneyTimeline {
  tripId: string;
  truckId: string;
  startTs: number;
  endTs: number;
  totalDurationS: number;
  movingDurationS: number;
  stoppedDurationS: number;
  distanceKm: number;
  avgSpeedKph: number;
  maxSpeedKph: number;
  stops: Stop[];
  unexplainedStops: Stop[];
  gaps: Array<{ fromTs: number; toTs: number; gapS: number }>;
  pingCount: number;
  verification: {
    anchored: boolean;
    batchCount: number;
    signerTier: SignerTier | null;
    disclosure: string | null;
  };
}

export interface AnchorLookup {
  batchCountForTrip(tripId: string): Promise<number>;
}

export class TimelineBuilder {
  constructor(
    private anchors: AnchorLookup,
    private stopOptions: StopDetectorOptions = {}
  ) {}

  async build(
    tripId: string,
    pings: SignedPing[],
    opts: StopDetectorOptions = {}
  ): Promise<JourneyTimeline> {
    if (pings.length === 0) throw new Error("NO_TELEMETRY_FOR_TRIP");

    const sorted = [...pings].sort((a, b) => a.ts - b.ts);
    const detector = new StopDetector({ ...this.stopOptions, ...opts });
    const stops = detector.detect(sorted);

    const startTs = sorted[0].ts;
    const endTs = sorted[sorted.length - 1].ts;
    const totalDurationS = endTs - startTs;
    const stoppedDurationS = stops.reduce((s, x) => s + x.durationS, 0);

    let distanceM = 0;
    let maxSpeedKph = 0;
    for (let i = 1; i < sorted.length; i++) {
      distanceM += haversineM(
        sorted[i - 1].lat, sorted[i - 1].lng, sorted[i].lat, sorted[i].lng
      );
      maxSpeedKph = Math.max(maxSpeedKph, sorted[i].speedKph ?? 0);
    }

    const movingDurationS = Math.max(0, totalDurationS - stoppedDurationS);
    const distanceKm = distanceM / 1000;

    const batchCount = await this.anchors.batchCountForTrip(tripId);
    const tier = sorted[0].signerTier ?? null;

    return {
      tripId,
      truckId: sorted[0].truckId,
      startTs,
      endTs,
      totalDurationS,
      movingDurationS,
      stoppedDurationS,
      distanceKm: Number(distanceKm.toFixed(2)),
      avgSpeedKph: movingDurationS > 0
        ? Number(((distanceKm / movingDurationS) * 3600).toFixed(1))
        : 0,
      maxSpeedKph,
      stops,
      unexplainedStops: StopDetector.unexplained(stops),
      gaps: MerkleBatcher.detectGaps(sorted),
      pingCount: sorted.length,
      verification: {
        anchored: batchCount > 0,
        batchCount,
        signerTier: tier,
        disclosure: tier !== null ? TRUST_DISCLOSURE[tier] : null,
      },
    };
  }

  /**
   * Plain-language rendering for the app, reports, and dispute narratives.
   * Gaps are stated explicitly rather than silently smoothed over — a route
   * with a 40-minute hole must not read as continuous.
   */
  static narrate(t: JourneyTimeline): string {
    const fmt = (ts: number) =>
      new Date(ts * 1000).toLocaleString("en-IN", {
        hour: "2-digit", minute: "2-digit", day: "numeric", month: "short",
      });
    const mins = (s: number) => `${Math.round(s / 60)} min`;

    const lines: string[] = [
      `Departed ${fmt(t.startTs)} · arrived ${fmt(t.endTs)} · ${t.distanceKm} km · avg ${t.avgSpeedKph} km/h`,
    ];

    for (const s of t.stops) {
      const label =
        s.classification === StopKind.UNEXPLAINED
          ? "⚠ unscheduled stop"
          : s.classification.toLowerCase().replace("_", " ");
      lines.push(
        `${fmt(s.startTs)} — ${label}, ${mins(s.durationS)} at ${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}`
      );
    }

    for (const g of t.gaps) {
      lines.push(
        `⚠ telemetry gap: no signal for ${mins(g.gapS)} between ${fmt(g.fromTs)} and ${fmt(g.toTs)}`
      );
    }

    lines.push(
      t.verification.anchored
        ? `Verified: ${t.verification.batchCount} anchored batches. ${t.verification.disclosure}`
        : `Not anchored — this timeline is a platform record, not independently verifiable.`
    );

    return lines.join("\n");
  }

  /**
   * The dispute question generator. Given a custody window where goods went
   * missing, returns the stops inside it that nobody has explained.
   */
  static suspiciousWithin(
    t: JourneyTimeline,
    custodyStartTs: number,
    custodyEndTs: number
  ): Stop[] {
    return t.unexplainedStops.filter(
      (s) => s.startTs >= custodyStartTs && s.endTs <= custodyEndTs
    );
  }
}