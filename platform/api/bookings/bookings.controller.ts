import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Req,
} from "@nestjs/common";
import { BookingsService } from "./bookings.service";
import { CreateBookingDto, AssignTruckDto, CancelBookingDto } from "./bookings.dto";
import { TenantRequest } from "../common/tenant.middleware";

@Controller("bookings")
export class BookingsController {
  constructor(private bookings: BookingsService) {}

  @Post()
  create(@Req() req: TenantRequest, @Body() dto: CreateBookingDto) {
    return this.bookings.create(req.transporterId, req.userId, dto);
  }

  @Get(":id")
  get(@Req() req: TenantRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.bookings.get(req.transporterId, id);
  }

  @Get()
  list(@Req() req: TenantRequest) {
    return this.bookings.list(req.transporterId);
  }

  @Post(":id/assign")
  assign(
    @Req() req: TenantRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AssignTruckDto
  ) {
    return this.bookings.assignTruck(req.transporterId, req.userId, id, dto);
  }

  @Post(":id/cancel")
  cancel(
    @Req() req: TenantRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CancelBookingDto
  ) {
    return this.bookings.cancel(req.transporterId, req.userId, id, dto.reason);
  }
}