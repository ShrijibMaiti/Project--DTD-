import {
  Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req,
} from "@nestjs/common";
import { FleetService } from "./fleet.service";
import { CreateTruckDto, CreateDriverDto, SetTruckStatusDto } from "./fleet.dto";
import { TenantRequest } from "../common/request.types";
import { Roles, RequiresPermission, RequiresModule } from "@dtd/identity/rbac/guards";
import { Role, Permission } from "@dtd/shared/roles.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";

@Controller("fleet")
@RequiresModule(PlatformModule.FLEET)   // class-level: applies to every route
export class FleetController {
  constructor(private fleet: FleetService) {}

  @Post("trucks")
  @RequiresPermission(Permission.FLEET_WRITE)
  addTruck(@Req() req: TenantRequest, @Body() dto: CreateTruckDto) {
    return this.fleet.addTruck(req.companyId, req.userId, dto);
  }

  @Get("trucks")
  @RequiresPermission(Permission.FLEET_READ)
  listTrucks(@Req() req: TenantRequest, @Query("status") status?: string) {
    return this.fleet.listTrucks(req.companyId, status);
  }

  @Patch("trucks/:id/status")
  @RequiresPermission(Permission.FLEET_WRITE)
  setTruckStatus(
    @Req() req: TenantRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SetTruckStatusDto
  ) {
    return this.fleet.setTruckStatus(req.companyId, id, dto.status);
  }

  @Post("drivers")
  @RequiresPermission(Permission.FLEET_WRITE)
  addDriver(@Req() req: TenantRequest, @Body() dto: CreateDriverDto) {
    return this.fleet.addDriver(req.companyId, req.userId, dto);
  }

  @Get("drivers")
  @RequiresPermission(Permission.FLEET_READ)
  listDrivers(@Req() req: TenantRequest) {
    return this.fleet.listDrivers(req.companyId);
  }

  @Get("availability")
  @RequiresPermission(Permission.FLEET_READ)
  availability(@Req() req: TenantRequest) {
    return this.fleet.availability(req.companyId);
  }
}