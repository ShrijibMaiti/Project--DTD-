import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Req,
} from "@nestjs/common";
import { KycService } from "./kyc.service";
import { SubmitKycDto, ReviewKycDto } from "./kyc.dto";
import { TenantRequest } from "../common/tenant.middleware";

@Controller("kyc")
export class KycController {
  constructor(private kyc: KycService) {}

  @Post("submit")
  submit(@Req() req: TenantRequest, @Body() dto: SubmitKycDto) {
    return this.kyc.submit(req.companyId, req.userId, dto);
  }

  @Get("status/:subjectType/:subjectId")
  status(
    @Req() req: TenantRequest,
    @Param("subjectType") subjectType: string,
    @Param("subjectId", ParseUUIDPipe) subjectId: string
  ) {
    return this.kyc.status(req.companyId, subjectType, subjectId);
  }

  /** Ops review endpoint (role-guard in production). */
  @Post(":id/review")
  review(
    @Req() req: TenantRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReviewKycDto
  ) {
    return this.kyc.review(req.companyId, req.userId, id, dto);
  }
}