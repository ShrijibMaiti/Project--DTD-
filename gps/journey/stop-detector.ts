/**
 * gps/journey/stop-detector.ts
 * Dwell-time clustering: turn a stream of coordinates into "stopped 40 min
 * at km 340."
 *
 * This is the single most useful derived signal in the project. It gives
 * Tier-1 customers a readable timeline, and gives dispute investigations the
 * exact question to ask: "what happened during the unscheduled 40-minute stop
 * inside the driver's custody window?"
 */

import type { SignedPing } from "../signing/gateway-signer";

export interface Stop {
  startTs: number;
  endTs: number;
  durationS: number;
  lat: number;
  lng: number;
  /** Max distance from the stop centroid across the cluster, in metres. */
  radiusM: number;
  pingCount: number;
  classification: StopKind;
}

export enum StopKind {
  PICKUP = "PICKUP",
  DROP = "DROP",
  KNOWN_HALT = "KNOWN_HALT",      // fuel pump, toll, dhaba on a known list
  TRAFFIC = "TRAFFIC",            // short, on-route, low radius
  REST = "REST",                  // long, overnight-shaped
  UNEXPLAINED = "UNEXPLAINED",    // the one investigations care about
}

export interface KnownLocation {
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  kind: StopKind;
}

export interface StopDetectorOptions {
  /** Below this speed the vehicle counts as stationary. */
  movingThresholdKph?: number;
  /** Cluster radius — GPS jitter while parked is typically <30 m. */
  clusterRadiusM?: number;
  /** Ignore anything shorter than this. */
  minStopDurationS?: number;
  /** Longer than this and it's a rest, not a halt. */
  restThresholdS?: number;
  knownLocations?: KnownLocation[];
  /** Trip stops from the booking, for PICKUP/DROP classification. */
  scheduledStops?: Array<{ lat: number; lng: number; kind: "PICKUP" | "DROP" }>;
}

const DEFAULTS: Required<Omit<StopDetectorOptions, "knownLocations" | "scheduledStops">> = {
  movingThresholdKph: 3,
  clusterRadiusM: 60,
  minStopDurationS: 300,   // 5 minutes
  restThresholdS: 10_800,  // 3 hours
};

export function haversineM(
  lat1: number, lng1: number, lat2: number, lng2: number
): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export class StopDetector {
  private opts: Required<Omit<StopDetectorOptions, "knownLocations" | "scheduledStops">>;
  private known: KnownLocation[];
  private scheduled: NonNullable<StopDetectorOptions["scheduledStops"]>;

  constructor(options: StopDetectorOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.known = options.knownLocations ?? [];
    this.scheduled = options.scheduledStops ?? [];
  }

  detect(pings: SignedPing[]): Stop[] {
    const sorted = [...pings].sort((a, b) => a.ts - b.ts);
    if (sorted.length < 2) return [];

    const stops: Stop[] = [];
    let cluster: SignedPing[] = [];

    const flush = () => {
      if (cluster.length < 2) { cluster = []; return; }
      const duration = cluster[cluster.length - 1].ts - cluster[0].ts;
      if (duration < this.opts.minStopDurationS) { cluster = []; return; }

      const lat = cluster.reduce((s, p) => s + p.lat, 0) / cluster.length;
      const lng = cluster.reduce((s, p) => s + p.lng, 0) / cluster.length;
      const radiusM = Math.max(
        ...cluster.map((p) => haversineM(lat, lng, p.lat, p.lng))
      );

      const stop: Stop = {
        startTs: cluster[0].ts,
        endTs: cluster[cluster.length - 1].ts,
        durationS: duration,
        lat, lng, radiusM,
        pingCount: cluster.length,
        classification: StopKind.UNEXPLAINED,
      };
      stop.classification = this.classify(stop);
      stops.push(stop);
      cluster = [];
    };

    for (const p of sorted) {
      const stationary = this.isStationary(p, cluster);
      if (stationary) cluster.push(p);
      else flush();
    }
    flush();

    return stops;
  }

  private isStationary(p: SignedPing, cluster: SignedPing[]): boolean {
    // Speed is the primary signal when the device reports it.
    if (p.speedKph !== undefined && p.speedKph > this.opts.movingThresholdKph) {
      return false;
    }
    if (cluster.length === 0) return true;
    // Otherwise fall back to spatial clustering against the cluster anchor.
    const anchor = cluster[0];
    return haversineM(anchor.lat, anchor.lng, p.lat, p.lng) <= this.opts.clusterRadiusM;
  }

  /**
   * Classification order matters: scheduled stops first (they explain
   * themselves), then known halts, then shape-based heuristics. Anything
   * left over is UNEXPLAINED — deliberately, because that is the category
   * an investigator should be handed rather than a system guess.
   */
  private classify(stop: Stop): StopKind {
    for (const s of this.scheduled) {
      if (haversineM(stop.lat, stop.lng, s.lat, s.lng) <= 300) {
        return s.kind === "PICKUP" ? StopKind.PICKUP : StopKind.DROP;
      }
    }
    for (const k of this.known) {
      if (haversineM(stop.lat, stop.lng, k.lat, k.lng) <= k.radiusM) {
        return k.kind;
      }
    }
    if (stop.durationS >= this.opts.restThresholdS) return StopKind.REST;
    if (stop.durationS < 900 && stop.radiusM < 40) return StopKind.TRAFFIC;
    return StopKind.UNEXPLAINED;
  }

  /** What a dispute investigation actually asks for. */
  static unexplained(stops: Stop[]): Stop[] {
    return stops.filter((s) => s.classification === StopKind.UNEXPLAINED);
  }
}