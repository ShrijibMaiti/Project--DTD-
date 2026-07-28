import { Controller, Get, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { ClaimsService } from "./claims.service";
import { TenantRequest } from "../common/tenant.middleware";

@Controller("claims")
export class ClaimsController {
  constructor(private claims: ClaimsService) {}

  /** Build the evidence packet for a booking: trip + docs + custody in one bundle. */
  @Post("packet/:bookingId")
  build(@Req() req: TenantRequest, @Param("bookingId", ParseUUIDPipe) bookingId: string) {
    return this.claims.buildPacket(req.transporterId, req.userId, bookingId);
  }

  @Get("packet/:bookingId")
  get(@Req() req: TenantRequest, @Param("bookingId", ParseUUIDPipe) bookingId: string) {
    return this.claims.getPacket(req.transporterId, bookingId);
  }
}