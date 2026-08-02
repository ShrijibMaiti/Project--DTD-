import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../common/database.service";
import { AuditService } from "../common/audit.service";
import { DeviceRegistry } from "@dtd/gps/ingest/device-registry";
import { IngestGateway } from "@dtd/gps/ingest/gateway";
import { TimelineBuilder } from "@dtd/gps/journey/timeline";
import { ProofApi } from "@dtd/gps/query/proof-api";
import { PgDeviceStore, PgDeviceAlertSink } from "@dtd/gps/db/device.store.pg";
import { PgPingBuffer, PgIngestMetrics } from "@dtd/gps/db/ping-buffer.store.pg";
import { PgBatchStore } from "@dtd/gps/db/batch.store.pg";
import { PgPingSource } from "@dtd/gps/db/ping-source.store.pg";
import { RedisRateLimiter } from "@dtd/gps/db/rate-limiter.redis";
import {
  RegisterDeviceDto, RotateSecretDto, StartTripDto, IngestPingDto,
  IngestBatchDto, WasVehicleNearDto,
} from "./gps.dto";

/**
 * One shared limiter instance — the Redis connection is process-wide, not
 * per-request. RateLimiter isn't a Postgres store scoped to a transaction
 * the way the others are, so it's the one dependency that lives outside
 * withTenant/asSystem.
 */
const rateLimiter = new RedisRateLimiter();

@Injectable()
export class GpsService {
  constructor(private db: DatabaseService, private audit: AuditService) {}

  // ---------------------------------------------------------------- devices

  async registerDevice(companyId: string, userId: string, dto: RegisterDeviceDto) {
    return this.db.withTenant(companyId, async (c) => {
      const registry = new DeviceRegistry(
        new PgDeviceStore(c, companyId),
        new PgDeviceAlertSink(c, companyId)
      );
      try {
        const device = await registry.register({ ...dto, companyId });
        await this.audit.record({
          companyId, userId,
          action: "GPS_DEVICE_REGISTERED", entity: "device", entityId: device.deviceId,
        });
        return device;
      } catch (err: any) {
        if (err.message === "DEVICE_ALREADY_REGISTERED") {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
    });
  }

  async rotateSecret(companyId: string, userId: string, deviceId: string, dto: RotateSecretDto) {
    return this.db.withTenant(companyId, async (c) => {
      const registry = new DeviceRegistry(
        new PgDeviceStore(c, companyId),
        new PgDeviceAlertSink(c, companyId)
      );
      try {
        await registry.rotateSecret(deviceId, dto.newSecret);
      } catch (err: any) {
        if (err.message === "DEVICE_NOT_FOUND") throw new NotFoundException();
        throw err;
      }
      await this.audit.record({
        companyId, userId, action: "GPS_DEVICE_SECRET_ROTATED", entity: "device", entityId: deviceId,
      });
      return { deviceId, rotated: true };
    });
  }

  async startTrip(companyId: string, userId: string, truckId: string, dto: StartTripDto) {
    return this.db.withTenant(companyId, async (c) => {
      const registry = new DeviceRegistry(
        new PgDeviceStore(c, companyId),
        new PgDeviceAlertSink(c, companyId)
      );
      try {
        await registry.startTrip(truckId, dto.tripId);
      } catch (err: any) {
        if (err.message?.startsWith("NO_DEVICE_FOR_TRUCK")) {
          throw new BadRequestException(err.message);
        }
        if (err.message === "DEVICE_NOT_ACTIVE") throw new BadRequestException(err.message);
        throw err;
      }
      await this.audit.record({
        companyId, userId, action: "GPS_TRIP_STARTED", entity: "truck", entityId: truckId,
        detail: { tripId: dto.tripId },
      });
      return { truckId, tripId: dto.tripId, started: true };
    });
  }

  async endTrip(companyId: string, userId: string, truckId: string, client?: PoolClient) {
    return this.db.withTenantOn(companyId, client, async (c) => {
      const registry = new DeviceRegistry(
        new PgDeviceStore(c, companyId),
        new PgDeviceAlertSink(c, companyId)
      );
      await registry.endTrip(truckId);
      await this.audit.record({
        companyId, userId, action: "GPS_TRIP_ENDED", entity: "truck", entityId: truckId,
      });
      return { truckId, ended: true };
    });
  }

  // ---------------------------------------------------------------- ingest
  // No companyId is known yet — @Public(), device auth only. Runs entirely
  // under system context; company_id for the write comes from the device
  // row itself, resolved inside the same transaction.

  async ingest(dto: IngestPingDto) {
    return this.db.asSystem(async (c) => {
      const lookup = new PgDeviceStore(c, "");
      const device = await lookup.get(dto.deviceId);
      const companyId = device?.companyId ?? "";

      const gateway = new IngestGateway(
        new DeviceRegistry(new PgDeviceStore(c, companyId), new PgDeviceAlertSink(c, companyId)),
        new PgPingBuffer(c, companyId),
        rateLimiter,
        new PgIngestMetrics(c, companyId)
      );
      return gateway.ingest(dto);
    });
  }

  async ingestBatch(dto: IngestBatchDto) {
    // IngestGateway.ingestBatch re-resolves each ping's device individually
    // (same as a loop of single ingest() calls), so no fixed companyId is
    // assumed across the batch — stores stay system-scoped throughout.
    return this.db.asSystem(async (c) => {
      const gateway = new IngestGateway(
        new DeviceRegistry(new PgDeviceStore(c, ""), new PgDeviceAlertSink(c, "")),
        new PgPingBuffer(c, ""),
        rateLimiter,
        new PgIngestMetrics(c, "")
      );
      return gateway.ingestBatch(dto.pings);
    });
  }

  // ---------------------------------------------------------------- reads

  async getTimeline(companyId: string, tripId: string) {
    return this.db.withTenant(companyId, async (c) => {
      const batchStore = new PgBatchStore(c, companyId);
      const pingSource = new PgPingSource(c);
      const pings = await pingSource.pingsInWindow(tripId, 0, Math.floor(Date.now() / 1000));
      if (pings.length === 0) throw new NotFoundException("NO_TELEMETRY_FOR_TRIP");

      const builder = new TimelineBuilder(batchStore);
      try {
        return await builder.build(tripId, pings);
      } catch (err: any) {
        if (err.message === "NO_TELEMETRY_FOR_TRIP") throw new NotFoundException(err.message);
        throw err;
      }
    });
  }

  async proveMoment(companyId: string, tripId: string, ts: number) {
    return this.db.withTenant(companyId, async (c) => {
      const proof = await new ProofApi(new PgPingSource(c)).proveMoment(tripId, ts);
      if (!proof) throw new NotFoundException("NO_ANCHORED_TELEMETRY_FOR_MOMENT");
      return proof;
    });
  }

  async wasVehicleNear(companyId: string, tripId: string, dto: WasVehicleNearDto) {
    return this.db.withTenant(companyId, (c) =>
      new ProofApi(new PgPingSource(c)).wasVehicleNear({ tripId, ...dto })
    );
  }

  async proveWindow(companyId: string, tripId: string, fromTs: number, toTs: number) {
    return this.db.withTenant(companyId, (c) =>
      new ProofApi(new PgPingSource(c)).proveWindow(tripId, fromTs, toTs)
    );
  }
}