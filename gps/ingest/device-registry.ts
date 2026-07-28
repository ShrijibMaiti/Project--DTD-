/**
 * gps/ingest/device-registry.ts
 * Device ↔ truck ↔ trip binding, health, and tamper flags.
 *
 * The health signals here are cheap fraud detection: a device that goes silent
 * exactly during the window goods went missing is evidence, and a device whose
 * MAC starts failing is either broken or being spoofed. Both get surfaced.
 */

export type DeviceStatus = "ACTIVE" | "SUSPENDED" | "RETIRED";

export interface Device {
  deviceId: string;
  truckId: string;
  companyId: string;
  sharedSecret: string;      // Phase-1; Phase-3 moves to secure-element keys
  status: DeviceStatus;
  lastSeenTs: number | null;
  tamperFlags: number;
  installedAt: string;
}

export interface Binding {
  deviceId: string;
  truckId: string;
  tripId: string | null;
  since: number;
}

export interface DeviceStore {
  get(deviceId: string): Promise<Device | null>;
  byTruck(truckId: string): Promise<Device | null>;
  upsert(d: Device): Promise<void>;
  setStatus(deviceId: string, status: DeviceStatus): Promise<void>;
  touch(deviceId: string, ts: number): Promise<void>;
  incrementTamper(deviceId: string): Promise<number>;
  activeBinding(deviceId: string): Promise<Binding | null>;
  bindTrip(deviceId: string, tripId: string): Promise<void>;
  unbindTrip(deviceId: string): Promise<void>;
  listStale(olderThanTs: number): Promise<Device[]>;
}

export interface DeviceAlertSink {
  raise(e: {
    kind: string;
    deviceId: string;
    detail: Record<string, unknown>;
    severity: "INFO" | "WARN" | "CRITICAL";
  }): Promise<void>;
}

const TAMPER_SUSPEND_THRESHOLD = 20;
const SILENCE_ALERT_S = 30 * 60;

export class DeviceRegistry {
  constructor(private store: DeviceStore, private alerts: DeviceAlertSink) {}

  get(deviceId: string) {
    return this.store.get(deviceId);
  }

  async register(input: {
    deviceId: string;
    truckId: string;
    companyId: string;
    sharedSecret: string;
  }): Promise<Device> {
    const existing = await this.store.get(input.deviceId);
    if (existing && existing.status !== "RETIRED") {
      throw new Error("DEVICE_ALREADY_REGISTERED");
    }
    const device: Device = {
      ...input,
      status: "ACTIVE",
      lastSeenTs: null,
      tamperFlags: 0,
      installedAt: new Date().toISOString(),
    };
    await this.store.upsert(device);
    return device;
  }

  /** Called when a trip starts — pins telemetry to a trip for anchoring. */
  async startTrip(truckId: string, tripId: string): Promise<void> {
    const device = await this.store.byTruck(truckId);
    if (!device) throw new Error(`NO_DEVICE_FOR_TRUCK:${truckId}`);
    if (device.status !== "ACTIVE") throw new Error("DEVICE_NOT_ACTIVE");
    await this.store.bindTrip(device.deviceId, tripId);
  }

  async endTrip(truckId: string): Promise<void> {
    const device = await this.store.byTruck(truckId);
    if (device) await this.store.unbindTrip(device.deviceId);
  }

  activeBinding(deviceId: string) {
    return this.store.activeBinding(deviceId);
  }

  touch(deviceId: string, ts: number) {
    return this.store.touch(deviceId, ts);
  }

  async flagTamper(deviceId: string, reason: string): Promise<void> {
    const count = await this.store.incrementTamper(deviceId);
    await this.alerts.raise({
      kind: "DEVICE_TAMPER_FLAG",
      deviceId,
      detail: { reason, count },
      severity: count >= TAMPER_SUSPEND_THRESHOLD ? "CRITICAL" : "WARN",
    });
    if (count >= TAMPER_SUSPEND_THRESHOLD) {
      await this.store.setStatus(deviceId, "SUSPENDED");
    }
  }

  /**
   * Health sweep — run every few minutes. A device silent mid-trip is the
   * signal that matters; silent while parked is normal.
   */
  async sweepSilent(): Promise<Device[]> {
    const cutoff = Math.floor(Date.now() / 1000) - SILENCE_ALERT_S;
    const stale = await this.store.listStale(cutoff);
    for (const d of stale) {
      const binding = await this.store.activeBinding(d.deviceId);
      if (!binding?.tripId) continue; // parked truck, not interesting
      await this.alerts.raise({
        kind: "DEVICE_SILENT_MID_TRIP",
        deviceId: d.deviceId,
        detail: {
          truckId: d.truckId,
          tripId: binding.tripId,
          lastSeenTs: d.lastSeenTs,
          silentForS: d.lastSeenTs
            ? Math.floor(Date.now() / 1000) - d.lastSeenTs
            : null,
        },
        severity: "CRITICAL",
      });
    }
    return stale;
  }

  /** Secret rotation — see chain/keys/rotation.md for the wider pattern. */
  async rotateSecret(deviceId: string, newSecret: string): Promise<void> {
    const d = await this.store.get(deviceId);
    if (!d) throw new Error("DEVICE_NOT_FOUND");
    await this.store.upsert({ ...d, sharedSecret: newSecret, tamperFlags: 0 });
  }
}