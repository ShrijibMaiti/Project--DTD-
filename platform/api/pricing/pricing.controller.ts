import { Body, Controller, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { PricingService } from "./pricing.service";
import { EstimateDto } from "./pricing.dto";
import { TenantRequest } from "../common/tenant.middleware";

@Controller("pricing")
export class PricingController {
  constructor(private pricing: PricingService) {}

  /** Instant estimate: returns a price RANGE + a quote id (valid 30 min). */
  @Post("estimate")
  estimate(@Req() req: TenantRequest, @Body() dto: EstimateDto) {
    return this.pricing.estimate(req.companyId, dto);
  }

  /** Ops confirms the exact market price within the 30-minute window. */
  @Post("quotes/:id/confirm")
  confirm(
    @Req() req: TenantRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body("finalPriceInr") finalPriceInr: number
  ) {
    return this.pricing.confirmMarketPrice(req.companyId, id, finalPriceInr);
  }
}