import { Controller, Get, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { ClaimsService } from "./claims.service";
import { TenantRequest } from "../common/request.types";
import { RequiresPermission, RequiresModule } from "@dtd/identity/rbac/guards";
import { Permission } from "@dtd/shared/roles.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";

@Controller("claims")
@RequiresModule(PlatformModule.CLAIMS_EVIDENCE)
export class ClaimsController {
  constructor(private claims: ClaimsService) {}

  /** Build the evidence packet for a booking: trip + docs + custody in one bundle. */
  @Post("packet/:bookingId")
  @RequiresPermission(Permission.CLAIMS_PACKET_BUILD)
  build(@Req() req: TenantRequest, @Param("bookingId", ParseUUIDPipe) bookingId: string) {
    return this.claims.buildPacket(req.companyId, req.userId, bookingId);
  }

  @Get("packet/:bookingId")
  @RequiresPermission(Permission.CLAIMS_PACKET_BUILD)
  get(@Req() req: TenantRequest, @Param("bookingId", ParseUUIDPipe) bookingId: string) {
    return this.claims.getPacket(req.companyId, bookingId);
  }
}