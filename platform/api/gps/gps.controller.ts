import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { GpsService } from "./gps.service";
import {
  RegisterDeviceDto, RotateSecretDto, StartTripDto, IngestPingDto,
  IngestBatchDto, WasVehicleNearDto,
} from "./gps.dto";
import { TenantRequest } from "../common/request.types";
import { RequiresPermission, RequiresModule, Public } from "@dtd/identity/rbac/guards";
import { Permission } from "@dtd/shared/roles.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";

@Controller("gps")
export class GpsController {
  constructor(private gps: GpsService) {}

  // ---------------------------------------------------------------- devices
  // FLEET_WRITE per confirmed mapping — no dedicated device permission
  // exists, and these are fleet-hardware operations. Module-gated too, not
  // left permission-only (per explicit instruction).

  @Post("devices")
  @RequiresModule(PlatformModule.GPS_TRACKING)
  @RequiresPermission(Permission.FLEET_WRITE)
  registerDevice(@Req() req: TenantRequest, @Body() dto: RegisterDeviceDto) {
    return this.gps.registerDevice(req.companyId, req.userId, dto);
  }

  @Post("devices/:deviceId/rotate-secret")
  @RequiresModule(PlatformModule.GPS_TRACKING)
  @RequiresPermission(Permission.FLEET_WRITE)
  rotateSecret(
    @Req() req: TenantRequest,
    @Param("deviceId") deviceId: string,
    @Body() dto: RotateSecretDto
  ) {
    return this.gps.rotateSecret(req.companyId, req.userId, deviceId, dto);
  }

  @Post("trucks/:truckId/start-trip")
  @RequiresModule(PlatformModule.GPS_TRACKING)
  @RequiresPermission(Permission.FLEET_WRITE)
  startTrip(
    @Req() req: TenantRequest,
    @Param("truckId") truckId: string,
    @Body() dto: StartTripDto
  ) {
    return this.gps.startTrip(req.companyId, req.userId, truckId, dto);
  }

  @Post("trucks/:truckId/end-trip")
  @RequiresModule(PlatformModule.GPS_TRACKING)
  @RequiresPermission(Permission.FLEET_WRITE)
  endTrip(@Req() req: TenantRequest, @Param("truckId") truckId: string) {
    return this.gps.endTrip(req.companyId, req.userId, truckId);
  }

  // ---------------------------------------------------------------- ingest
  // Device auth, not JWT — IngestGateway.verifyMac() does the real check
  // per-device. @Public() is load-bearing, same reason as payments' webhook.

  @Post("ingest")
  @Public()
  ingest(@Body() dto: IngestPingDto) {
    return this.gps.ingest(dto);
  }

  @Post("ingest/batch")
  @Public()
  ingestBatch(@Body() dto: IngestBatchDto) {
    return this.gps.ingestBatch(dto);
  }

  // ---------------------------------------------------------------- reads
  // Timeline: GPS_TRACKING + TRACKING_VIEW (Starter tier). Proof: the
  // stricter GPS_ANCHORING + TRACKING_VIEW (Enterprise tier — anchoring is
  // what makes a proof legally meaningful), per confirmed mapping.

  @Get("trips/:tripId/timeline")
  @RequiresModule(PlatformModule.GPS_TRACKING)
  @RequiresPermission(Permission.TRACKING_VIEW)
  getTimeline(@Req() req: TenantRequest, @Param("tripId") tripId: string) {
    return this.gps.getTimeline(req.companyId, tripId);
  }

  @Get("trips/:tripId/proof")
  @RequiresModule(PlatformModule.GPS_ANCHORING)
  @RequiresPermission(Permission.TRACKING_VIEW)
  proveMoment(
    @Req() req: TenantRequest,
    @Param("tripId") tripId: string,
    @Query("ts") ts: string
  ) {
    return this.gps.proveMoment(req.companyId, tripId, Number(ts));
  }

  @Get("trips/:tripId/near")
  @RequiresModule(PlatformModule.GPS_ANCHORING)
  @RequiresPermission(Permission.TRACKING_VIEW)
  wasVehicleNear(
    @Req() req: TenantRequest,
    @Param("tripId") tripId: string,
    @Query() dto: WasVehicleNearDto
  ) {
    return this.gps.wasVehicleNear(req.companyId, tripId, dto);
  }

  @Get("trips/:tripId/proof-window")
  @RequiresModule(PlatformModule.GPS_ANCHORING)
  @RequiresPermission(Permission.TRACKING_VIEW)
  proveWindow(
    @Req() req: TenantRequest,
    @Param("tripId") tripId: string,
    @Query("from") from: string,
    @Query("to") to: string
  ) {
    return this.gps.proveWindow(req.companyId, tripId, Number(from), Number(to));
  }
}
