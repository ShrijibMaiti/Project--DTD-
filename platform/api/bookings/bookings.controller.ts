import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Req,
} from "@nestjs/common";
import { BookingsService } from "./bookings.service";
import { CreateBookingDto, AssignTruckDto, CancelBookingDto } from "./bookings.dto";
import { TenantRequest } from "../common/request.types";
import { RequiresPermission, RequiresModule } from "@dtd/identity/rbac/guards";
import { Permission } from "@dtd/shared/roles.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";

@Controller("bookings")
@RequiresModule(PlatformModule.TRIPS)
export class BookingsController {
  constructor(private bookings: BookingsService) {}

  @Post()
  @RequiresPermission(Permission.TRIP_CREATE)
  create(@Req() req: TenantRequest, @Body() dto: CreateBookingDto) {
    return this.bookings.create(req.companyId, req.userId, dto);
  }

  @Get(":id")
  @RequiresPermission(Permission.TRIP_READ_ALL)
  get(@Req() req: TenantRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.bookings.get(req.companyId, id);
  }

  /**
   * TRIP_READ_ALL, not TRIP_READ_OWN — a DRIVER must never receive the
   * company-wide list. His own trips come from a separate driver-scoped
   * endpoint (Domain 5), filtered by PermissionService.tripScope().
   */
  @Get()
  @RequiresPermission(Permission.TRIP_READ_ALL)
  list(@Req() req: TenantRequest) {
    return this.bookings.list(req.companyId);
  }

  @Post(":id/assign")
  @RequiresPermission(Permission.TRIP_ASSIGN)
  assign(
    @Req() req: TenantRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AssignTruckDto
  ) {
    return this.bookings.assignTruck(req.companyId, req.userId, id, dto);
  }

  @Post(":id/cancel")
  @RequiresPermission(Permission.TRIP_CANCEL)
  cancel(
    @Req() req: TenantRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CancelBookingDto
  ) {
    return this.bookings.cancel(req.companyId, req.userId, id, dto.reason);
  }
}