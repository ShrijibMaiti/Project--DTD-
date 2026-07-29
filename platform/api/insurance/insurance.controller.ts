import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { InsuranceService } from "./insurance.service";
import { BuyPolicyDto } from "./insurance.dto";
import { TenantRequest } from "../common/request.types";
import { RequiresPermission, RequiresModule } from "@dtd/identity/rbac/guards";
import { Permission } from "@dtd/shared/roles.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";

@Controller("insurance")
@RequiresModule(PlatformModule.PAYMENTS)
export class InsuranceController {
  constructor(private insurance: InsuranceService) {}

  @Post("quote")
  @RequiresPermission(Permission.PAYMENT_READ)
  quote(@Req() req: TenantRequest, @Body() dto: BuyPolicyDto) {
    return this.insurance.quote(req.companyId, dto);
  }

  /** Buying cover spends money — PAYMENT_COLLECT, not PAYMENT_READ. */
  @Post("buy")
  @RequiresPermission(Permission.PAYMENT_COLLECT)
  buy(@Req() req: TenantRequest, @Body() dto: BuyPolicyDto) {
    return this.insurance.buy(req.companyId, req.userId, dto);
  }

  @Get("policies/:bookingId")
  @RequiresPermission(Permission.PAYMENT_READ)
  policy(@Req() req: TenantRequest, @Param("bookingId", ParseUUIDPipe) bookingId: string) {
    return this.insurance.getPolicy(req.companyId, bookingId);
  }
}