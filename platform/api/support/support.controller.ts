import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Req,
} from "@nestjs/common";
import { SupportService } from "./support.service";
import { CreateTicketDto, ReplyTicketDto } from "./support.dto";
import { TenantRequest } from "../common/request.types";
import { RequiresPermission, RequiresModule } from "@dtd/identity/rbac/guards";
import { Permission } from "@dtd/shared/roles.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";

/**
 * No @RequiresPermission on tickets: every role may ask for help, including
 * a driver stuck at a loading dock. Deliberately the one place where the
 * permission matrix stays out of the way.
 */
@Controller("support")
@RequiresModule(PlatformModule.SUPPORT)
export class SupportController {
  constructor(private support: SupportService) {}

  @Post("tickets")
  create(@Req() req: TenantRequest, @Body() dto: CreateTicketDto) {
    return this.support.createTicket(req.companyId, req.userId, dto);
  }

  @Get("tickets")
  list(@Req() req: TenantRequest) {
    return this.support.listTickets(req.companyId);
  }

  @Post("tickets/:id/reply")
  reply(
    @Req() req: TenantRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReplyTicketDto
  ) {
    return this.support.reply(req.companyId, req.userId, id, dto.message);
  }

  /** Connecting to a driver exposes trip state — gated on TRACKING_VIEW. */
  @Post("call-driver/:bookingId")
  @RequiresPermission(Permission.TRACKING_VIEW)
  callDriver(@Req() req: TenantRequest, @Param("bookingId", ParseUUIDPipe) bookingId: string) {
    return this.support.callDriver(req.companyId, req.userId, bookingId);
  }
}