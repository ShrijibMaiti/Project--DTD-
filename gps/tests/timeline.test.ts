/**
 * gps/tests/timeline.test.ts
 * Stop detection matches known routes; unexplained stops surface for disputes.
 */

import { describe, it, expect } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import { StopDetector, StopKind, haversineM } from "../journey/stop-detector";
import { TimelineBuilder } from "../journey/timeline";
import { SignerTier, type SignedPing } from "../signing/gateway-signer";

const TRIP = keccak256(toHex("trip-timeline-001"));

function ping(lat: number, lng: number, ts: number, speedKph = 50): SignedPing {
  return {
    deviceId: "DEV-001",
    truckId: "truck-1",
    tripId: TRIP,
    lat, lng, ts, speedKph,
    receivedAt: ts + 3,
    signerTier: SignerTier.GATEWAY_VERIFIED_DEVICE,
    signerAddress: "0x1111111111111111111111111111111111111111",
    gatewaySig: ("0x" + "ab".repeat(65)) as Hex,
  };
}

/** Delhi → Jaipur, 30s cadence, with an optional stationary halt inserted. */
function synthRoute(opts: {
  halts?: Array<{ afterIndex: number; durationS: number; lat?: number; lng?: number }>;
  points?: number;
} = {}): SignedPing[] {
  const points = opts.points ?? 60;
  const out: SignedPing[] = [];
  let ts = 1_760_000_000;
  let lat = 28.6139, lng = 77.209;

  for (let i = 0; i < points; i++) {
    out.push(ping(lat, lng, ts));
    const halt = opts.halts?.find((h) => h.afterIndex === i);
    if (halt) {
      const hLat = halt.lat ?? lat;
      const hLng = halt.lng ?? lng;
      const steps = Math.floor(halt.durationS / 30);
      for (let s = 0; s < steps; s++) {
        ts += 30;
        // GPS jitter while parked: a few metres
        out.push(ping(hLat + (Math.random() - 0.5) * 0.0002,
                      hLng + (Math.random() - 0.5) * 0.0002, ts, 0));
      }
      lat = hLat; lng = hLng;
    }
    ts += 30;
    lat -= 0.028;
    lng -= 0.023;
  }
  return out;
}

const anchors = { batchCountForTrip: async () => 3 };
const noAnchors = { batchCountForTrip: async () => 0 };

describe("haversine", () => {
  it("Delhi to Jaipur is roughly 240 km", () => {
    const d = haversineM(28.6139, 77.209, 26.9124, 75.7873) / 1000;
    expect(d).toBeGreaterThan(220);
    expect(d).toBeLessThan(260);
  });

  it("identical points are zero apart", () => {
    expect(haversineM(28.6, 77.2, 28.6, 77.2)).toBe(0);
  });
});

describe("StopDetector", () => {
  it("finds a 40-minute halt in the middle of a route", () => {
    const pings = synthRoute({ halts: [{ afterIndex: 20, durationS: 2400 }] });
    const stops = new StopDetector().detect(pings);

    expect(stops).toHaveLength(1);
    expect(stops[0].durationS).toBeGreaterThanOrEqual(2340);
    expect(stops[0].pingCount).toBeGreaterThan(70);
  });

  it("ignores brief slowdowns below the minimum duration", () => {
    const pings = synthRoute({ halts: [{ afterIndex: 20, durationS: 120 }] });
    expect(new StopDetector().detect(pings)).toHaveLength(0);
  });

  it("finds multiple stops on one trip", () => {
    const pings = synthRoute({
      halts: [
        { afterIndex: 10, durationS: 1800 },
        { afterIndex: 35, durationS: 900 },
      ],
    });
    expect(new StopDetector().detect(pings)).toHaveLength(2);
  });

  it("classifies a stop at a scheduled DROP correctly", () => {
    const pings = synthRoute({
      halts: [{ afterIndex: 20, durationS: 2400, lat: 27.5, lng: 76.75 }],
    });
    const stops = new StopDetector({
      scheduledStops: [{ lat: 27.5, lng: 76.75, kind: "DROP" }],
    }).detect(pings);

    expect(stops[0].classification).toBe(StopKind.DROP);
  });

  it("classifies a stop at a known dhaba as KNOWN_HALT", () => {
    const pings = synthRoute({
      halts: [{ afterIndex: 20, durationS: 2400, lat: 27.5, lng: 76.75 }],
    });
    const stops = new StopDetector({
      knownLocations: [
        { name: "Highway dhaba", lat: 27.5, lng: 76.75, radiusM: 200, kind: StopKind.KNOWN_HALT },
      ],
    }).detect(pings);

    expect(stops[0].classification).toBe(StopKind.KNOWN_HALT);
  });

  it("THE DISPUTE CASE: an unscheduled 40-min stop is UNEXPLAINED", () => {
    const pings = synthRoute({
      halts: [{ afterIndex: 20, durationS: 2400, lat: 27.5, lng: 76.75 }],
    });
    // No scheduled stop, no known location anywhere near it.
    const stops = new StopDetector({
      scheduledStops: [{ lat: 26.9124, lng: 75.7873, kind: "DROP" }],
    }).detect(pings);

    expect(stops[0].classification).toBe(StopKind.UNEXPLAINED);
    expect(StopDetector.unexplained(stops)).toHaveLength(1);
  });

  it("classifies an overnight halt as REST, not suspicious", () => {
    const pings = synthRoute({ halts: [{ afterIndex: 20, durationS: 25_200 }] });
    const stops = new StopDetector().detect(pings);
    expect(stops[0].classification).toBe(StopKind.REST);
  });

  it("returns nothing for a route with no stops", () => {
    expect(new StopDetector().detect(synthRoute())).toHaveLength(0);
  });
});

describe("TimelineBuilder", () => {
  it("builds a full timeline with distance and durations", async () => {
    const pings = synthRoute({ halts: [{ afterIndex: 20, durationS: 2400 }] });
    const t = await new TimelineBuilder(anchors).build(TRIP, pings);

    expect(t.pingCount).toBe(pings.length);
    expect(t.distanceKm).toBeGreaterThan(100);
    expect(t.stoppedDurationS).toBeGreaterThan(2000);
    expect(t.movingDurationS).toBeGreaterThan(0);
    expect(t.totalDurationS).toBe(t.endTs - t.startTs);
  });

  it("reports anchored verification with the honest tier disclosure", async () => {
    const t = await new TimelineBuilder(anchors).build(TRIP, synthRoute());
    expect(t.verification.anchored).toBe(true);
    expect(t.verification.batchCount).toBe(3);
    expect(t.verification.disclosure).toContain("gateway");
  });

  it("HONESTY: an unanchored trip says so plainly", async () => {
    const t = await new TimelineBuilder(noAnchors).build(TRIP, synthRoute());
    expect(t.verification.anchored).toBe(false);
    expect(TimelineBuilder.narrate(t)).toContain("not independently verifiable");
  });

  it("HONESTY: telemetry gaps appear in the narrative, never smoothed", async () => {
    const a = synthRoute({ points: 20 });
    const b = synthRoute({ points: 20 }).map((p) => ({ ...p, ts: p.ts + 100_000 }));
    const t = await new TimelineBuilder(anchors).build(TRIP, [...a, ...b]);

    expect(t.gaps.length).toBeGreaterThan(0);
    expect(TimelineBuilder.narrate(t)).toContain("telemetry gap");
  });

  it("narrate() flags unscheduled stops with a warning marker", async () => {
    const pings = synthRoute({
      halts: [{ afterIndex: 20, durationS: 2400, lat: 27.5, lng: 76.75 }],
    });
    const t = await new TimelineBuilder(anchors, {
      scheduledStops: [{ lat: 26.9124, lng: 75.7873, kind: "DROP" }],
    }).build(TRIP, pings);

    expect(TimelineBuilder.narrate(t)).toContain("unscheduled stop");
  });

  it("THE INVESTIGATION QUERY: suspicious stops inside a custody window", async () => {
    const pings = synthRoute({
      halts: [{ afterIndex: 20, durationS: 2400, lat: 27.5, lng: 76.75 }],
    });
    const t = await new TimelineBuilder(anchors, {
      scheduledStops: [{ lat: 26.9124, lng: 75.7873, kind: "DROP" }],
    }).build(TRIP, pings);

    const inWindow = TimelineBuilder.suspiciousWithin(t, t.startTs, t.endTs);
    expect(inWindow).toHaveLength(1);

    const outsideWindow = TimelineBuilder.suspiciousWithin(t, t.endTs + 1, t.endTs + 1000);
    expect(outsideWindow).toHaveLength(0);
  });

  it("throws rather than inventing a timeline from no telemetry", async () => {
    await expect(new TimelineBuilder(anchors).build(TRIP, [])).rejects.toThrow(
      "NO_TELEMETRY_FOR_TRIP"
    );
  });
});