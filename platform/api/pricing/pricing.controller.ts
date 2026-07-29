import { Body, Controller, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { PricingService } from "./pricing.service";
import { EstimateDto } from "./pricing.dto";
import { TenantRequest } from "../common/request.types";
import { RequiresPermission, RequiresModule } from "@dtd/identity/rbac/guards";
import { Permission } from "@dtd/shared/roles.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";

@Controller("pricing")
@RequiresModule(PlatformModule.TRIPS)
export class PricingController {
  constructor(private pricing: PricingService) {}

  /** Instant estimate: returns a price RANGE + a quote id (valid 30 min). */
  @Post("estimate")
  @RequiresPermission(Permission.TRIP_CREATE)
  estimate(@Req() req: TenantRequest, @Body() dto: EstimateDto) {
    return this.pricing.estimate(req.companyId, dto);
  }

  /** Ops confirms the exact market price within the 30-minute window. */
  @Post("quotes/:id/confirm")
  @RequiresPermission(Permission.TRIP_CREATE)
  confirm(
    @Req() req: TenantRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body("finalPriceInr") finalPriceInr: number
  ) {
    return this.pricing.confirmMarketPrice(req.companyId, id, finalPriceInr);
  }
}