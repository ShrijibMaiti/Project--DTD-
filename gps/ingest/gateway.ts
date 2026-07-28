/**
 * gps/ingest/gateway.ts
 * The firehose. MQTT/HTTP ping intake, kept deliberately boring: authenticate
 * the device, sanity-check the reading, rate-limit, buffer. Everything clever
 * happens downstream.
 *
 * Design rule: the gateway NEVER drops a ping silently. Rejections are counted
 * and surfaced — a device quietly failing auth for a week is a tampering signal,
 * not a log line nobody reads.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { DeviceRegistry } from "./device-registry";

export interface RawPing {
  deviceId: string;
  lat: number;
  lng: number;
  /** unix seconds */
  ts: number;
  speedKph?: number;
  headingDeg?: number;
  /** device-computed HMAC over the canonical ping (Phase-1: shared secret) */
  deviceMac?: string;
}

export enum RejectReason {
  UNKNOWN_DEVICE = "UNKNOWN_DEVICE",
  DEVICE_INACTIVE = "DEVICE_INACTIVE",
  BAD_MAC = "BAD_MAC",
  OUT_OF_RANGE = "OUT_OF_RANGE",
  STALE = "STALE",
  FUTURE = "FUTURE",
  RATE_LIMITED = "RATE_LIMITED",
  NO_ACTIVE_TRIP = "NO_ACTIVE_TRIP",
}

export interface AcceptedPing extends RawPing {
  truckId: string;
  tripId: string;
  receivedAt: number;
}

export interface PingBuffer {
  push(p: AcceptedPing): Promise<void>;
}

export interface RateLimiter {
  allow(deviceId: string): Promise<boolean>;
}

export interface IngestMetrics {
  accepted(deviceId: string): void;
  rejected(deviceId: string, reason: RejectReason): void;
}

export type IngestResult =
  | { ok: true; ping: AcceptedPing }
  | { ok: false; reason: RejectReason };

const MAX_CLOCK_SKEW_S = 120;      // device clocks drift; 2 min tolerance
const MAX_BACKFILL_S = 24 * 3600;  // offline devices replay up to a day

export class IngestGateway {
  constructor(
    private devices: DeviceRegistry,
    private buffer: PingBuffer,
    private limiter: RateLimiter,
    private metrics: IngestMetrics
  ) {}

  async ingest(raw: RawPing): Promise<IngestResult> {
    const reject = (reason: RejectReason) => {
      this.metrics.rejected(raw.deviceId, reason);
      return { ok: false as const, reason };
    };

    if (!(await this.limiter.allow(raw.deviceId))) {
      return reject(RejectReason.RATE_LIMITED);
    }

    const device = await this.devices.get(raw.deviceId);
    if (!device) return reject(RejectReason.UNKNOWN_DEVICE);
    if (device.status !== "ACTIVE") return reject(RejectReason.DEVICE_INACTIVE);

    if (!this.verifyMac(raw, device.sharedSecret)) {
      await this.devices.flagTamper(raw.deviceId, "BAD_MAC");
      return reject(RejectReason.BAD_MAC);
    }

    if (!this.plausible(raw)) return reject(RejectReason.OUT_OF_RANGE);

    const now = Math.floor(Date.now() / 1000);
    if (raw.ts > now + MAX_CLOCK_SKEW_S) return reject(RejectReason.FUTURE);
    if (raw.ts < now - MAX_BACKFILL_S) return reject(RejectReason.STALE);

    const binding = await this.devices.activeBinding(raw.deviceId);
    if (!binding?.tripId) return reject(RejectReason.NO_ACTIVE_TRIP);

    const ping: AcceptedPing = {
      ...raw,
      truckId: binding.truckId,
      tripId: binding.tripId,
      receivedAt: now,
    };

    await this.buffer.push(ping);
    await this.devices.touch(raw.deviceId, raw.ts);
    this.metrics.accepted(raw.deviceId);
    return { ok: true, ping };
  }

  /** Bulk path for devices flushing an offline queue. */
  async ingestBatch(pings: RawPing[]) {
    let accepted = 0;
    const rejections: Record<string, number> = {};
    for (const p of pings) {
      const r = await this.ingest(p);
      if (r.ok) accepted++;
      else rejections[r.reason] = (rejections[r.reason] ?? 0) + 1;
    }
    return { accepted, rejected: pings.length - accepted, rejections };
  }

  // ---------------------------------------------------------------- checks

  private verifyMac(raw: RawPing, secret: string): boolean {
    if (!raw.deviceMac) return false;
    const expected = createHmac("sha256", secret)
      .update(canonicalPing(raw))
      .digest("hex");
    const a = Buffer.from(raw.deviceMac);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private plausible(p: RawPing): boolean {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false;
    if (p.lat < -90 || p.lat > 90 || p.lng < -180 || p.lng > 180) return false;
    if (p.lat === 0 && p.lng === 0) return false; // null island = GPS not locked
    if (p.speedKph !== undefined && (p.speedKph < 0 || p.speedKph > 200)) return false;
    return true;
  }
}

/** Canonical form for MAC computation. Frozen — device firmware depends on it. */
export function canonicalPing(p: RawPing): string {
  return [
    p.deviceId,
    Math.round(p.lat * 1e6),
    Math.round(p.lng * 1e6),
    p.ts,
    p.speedKph ?? "",
    p.headingDeg ?? "",
  ].join("|");
}