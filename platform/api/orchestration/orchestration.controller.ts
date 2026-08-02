import { Body, Controller, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { OrchestrationService } from "./orchestration.service";
import { StartTripDto, ConfirmTripDeliveryDto } from "./orchestration.dto";
import { TenantRequest } from "../common/request.types";
import { RequiresPermission, RequiresModule } from "@dtd/identity/rbac/guards";
import { Permission } from "@dtd/shared/roles.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";

/**
 * Cross-domain routes. Single-domain work keeps its own controllers —
 * /bookings, /custody, /gps are all unchanged and still directly usable.
 *
 * MODULE GATING, and why it is checked twice.
 * The class-level @RequiresModule(TRIPS) covers the base capability: without
 * it there is nothing to orchestrate. But CUSTODY_TRACKING and GPS_TRACKING
 * gate OPTIONAL steps inside the flow, and a guard cannot express "run this
 * part only if entitled" — it can only allow or reject the whole request.
 *
 * So the service re-checks them against req.actor.modules and reports the
 * outcome per step. A Starter customer gets a successful trip start with
 * custody and GPS marked skipped and a reason, rather than a 402 that blocks
 * an operation they are entitled to perform.
 */
@Controller("trips")
@RequiresModule(PlatformModule.TRIPS)
export class OrchestrationController {
  constructor(private orchestration: OrchestrationService) {}

  /**
   * Assign truck + driver, mint the trip identity, create the custody
   * manifest, bind the GPS device — one transaction, explicit result.
   *
   * TRIP_ASSIGN, matching POST /bookings/:id/assign, because that is the
   * privileged act here. COMPANY_ADMIN and DISPATCHER hold it; DRIVER and
   * RECEIVER do not.
   */
  @Post(":bookingId/start")
  @RequiresPermission(Permission.TRIP_ASSIGN)
  startTrip(
    @Req() req: TenantRequest,
    @Param("bookingId", ParseUUIDPipe) bookingId: string,
    @Body() dto: StartTripDto
  ) {
    return this.orchestration.startTrip({
      companyId: req.companyId,
      userId: req.userId,
      bookingId,
      modules: req.modules,
      dto,
    });
  }

  /**
   * The receiver signs for what actually arrived; the booking follows.
   *
   * DELIVERY_CONFIRM is a RECEIVER permission — the same gate as
   * POST /custody/manifests/:id/confirm-delivery, because it is the same act
   * viewed from the trip rather than the manifest.
   */
  @Post(":bookingId/confirm-delivery")
  @RequiresPermission(Permission.DELIVERY_CONFIRM)
  confirmDelivery(
    @Req() req: TenantRequest,
    @Param("bookingId", ParseUUIDPipe) bookingId: string,
    @Body() dto: ConfirmTripDeliveryDto
  ) {
    return this.orchestration.confirmDelivery({
      companyId: req.companyId,
      userId: req.userId,
      bookingId,
      modules: req.modules,
      dto,
    });
  }
}
