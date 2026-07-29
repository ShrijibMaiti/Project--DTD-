import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Req,
} from "@nestjs/common";
import { KycService } from "./kyc.service";
import { SubmitKycDto, ReviewKycDto } from "./kyc.dto";
import { TenantRequest } from "../common/request.types";
import { RequiresPermission, RequiresModule } from "@dtd/identity/rbac/guards";
import { Permission } from "@dtd/shared/roles.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";

/** CORE is in every plan — verification is never a paid upsell. */
@Controller("kyc")
@RequiresModule(PlatformModule.CORE)
export class KycController {
  constructor(private kyc: KycService) {}

  @Post("submit")
  @RequiresPermission(Permission.FLEET_WRITE)
  submit(@Req() req: TenantRequest, @Body() dto: SubmitKycDto) {
    return this.kyc.submit(req.companyId, req.userId, dto);
  }

  @Get("status/:subjectType/:subjectId")
  @RequiresPermission(Permission.FLEET_READ)
  status(
    @Req() req: TenantRequest,
    @Param("subjectType") subjectType: string,
    @Param("subjectId", ParseUUIDPipe) subjectId: string
  ) {
    return this.kyc.status(req.companyId, subjectType, subjectId);
  }

  /** Review is a company-settings action, not a fleet one. */
  @Post(":id/review")
  @RequiresPermission(Permission.COMPANY_SETTINGS)
  review(
    @Req() req: TenantRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReviewKycDto
  ) {
    return this.kyc.review(req.companyId, req.userId, id, dto);
  }
}