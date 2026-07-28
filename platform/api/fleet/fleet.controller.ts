import {
  Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req,
} from "@nestjs/common";
import { FleetService } from "./fleet.service";
import { CreateTruckDto, CreateDriverDto, SetTruckStatusDto } from "./fleet.dto";
import { TenantRequest } from "../common/tenant.middleware";

@Controller("fleet")
export class FleetController {
  constructor(private fleet: FleetService) {}

  @Post("trucks")
  addTruck(@Req() req: TenantRequest, @Body() dto: CreateTruckDto) {
    return this.fleet.addTruck(req.transporterId, req.userId, dto);
  }

  @Get("trucks")
  listTrucks(@Req() req: TenantRequest, @Query("status") status?: string) {
    return this.fleet.listTrucks(req.transporterId, status);
  }

  @Patch("trucks/:id/status")
  setTruckStatus(
    @Req() req: TenantRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SetTruckStatusDto
  ) {
    return this.fleet.setTruckStatus(req.transporterId, id, dto.status);
  }

  @Post("drivers")
  addDriver(@Req() req: TenantRequest, @Body() dto: CreateDriverDto) {
    return this.fleet.addDriver(req.transporterId, req.userId, dto);
  }

  @Get("drivers")
  listDrivers(@Req() req: TenantRequest) {
    return this.fleet.listDrivers(req.transporterId);
  }

  @Get("availability")
  availability(@Req() req: TenantRequest) {
    return this.fleet.availability(req.transporterId);
  }
}