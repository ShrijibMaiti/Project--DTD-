import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Req,
} from "@nestjs/common";
import { SupportService } from "./support.service";
import { CreateTicketDto, ReplyTicketDto } from "./support.dto";
import { TenantRequest } from "../common/tenant.middleware";

@Controller("support")
export class SupportController {
  constructor(private support: SupportService) {}

  @Post("tickets")
  create(@Req() req: TenantRequest, @Body() dto: CreateTicketDto) {
    return this.support.createTicket(req.transporterId, req.userId, dto);
  }

  @Get("tickets")
  list(@Req() req: TenantRequest) {
    return this.support.listTickets(req.transporterId);
  }

  @Post("tickets/:id/reply")
  reply(
    @Req() req: TenantRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReplyTicketDto
  ) {
    return this.support.reply(req.transporterId, req.userId, id, dto.message);
  }

  /**
   * Call-driver: returns a masked bridge number so neither party sees the
   * other's real phone. Wire to Exotel/Twilio number-masking in production.
   */
  @Post("call-driver/:bookingId")
  callDriver(@Req() req: TenantRequest, @Param("bookingId", ParseUUIDPipe) bookingId: string) {
    return this.support.callDriver(req.transporterId, req.userId, bookingId);
  }
}