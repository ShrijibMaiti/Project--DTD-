import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { InsuranceService } from "./insurance.service";
import { BuyPolicyDto } from "./insurance.dto";
import { TenantRequest } from "../common/tenant.middleware";

@Controller("insurance")
export class InsuranceController {
  constructor(private insurance: InsuranceService) {}

  @Post("quote")
  quote(@Req() req: TenantRequest, @Body() dto: BuyPolicyDto) {
    return this.insurance.quote(req.companyId, dto);
  }

  @Post("buy")
  buy(@Req() req: TenantRequest, @Body() dto: BuyPolicyDto) {
    return this.insurance.buy(req.companyId, req.userId, dto);
  }

  @Get("policies/:bookingId")
  policy(@Req() req: TenantRequest, @Param("bookingId", ParseUUIDPipe) bookingId: string) {
    return this.insurance.getPolicy(req.companyId, bookingId);
  }
}