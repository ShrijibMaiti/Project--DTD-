import {
  BadRequestException, Body, Controller, Get, Headers, Param,
  ParseUUIDPipe, Post, Req, UsePipes, ValidationPipe,
} from "@nestjs/common";
import { PaymentsService } from "./payments.service";
import { CreateCollectionDto } from "./payments.dto";
import { TenantRequest } from "../common/request.types";
import { RequiresPermission, RequiresModule, Public } from "@dtd/identity/rbac/guards";
import { Permission } from "@dtd/shared/roles.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";

@Controller("payments")
@RequiresModule(PlatformModule.PAYMENTS)
export class PaymentsController {
  constructor(private payments: PaymentsService) {}

  /** Payment is due when the vehicle reaches the loading point. */
  @Post("collect")
  @RequiresPermission(Permission.PAYMENT_COLLECT)
  collect(@Req() req: TenantRequest, @Body() dto: CreateCollectionDto) {
    return this.payments.createCollection(req.companyId, req.userId, dto);
  }

  @Get(":bookingId")
  @RequiresPermission(Permission.PAYMENT_READ)
  get(@Req() req: TenantRequest, @Param("bookingId", ParseUUIDPipe) bookingId: string) {
    return this.payments.getByBooking(req.companyId, bookingId);
  }

  /**
   * Gateway webhook — authenticated by HMAC signature, NOT bearer token.
   *
   * @Public() is load-bearing: the global guard would otherwise 401 this
   * before the signature check ever runs. It also overrides the class-level
   * @RequiresModule — a payment processor has no plan and no token.
   */
  @Post("webhook/gateway")
  @Public()
  @UsePipes(new ValidationPipe({ whitelist: false, forbidNonWhitelisted: false, transform: false }))
  gatewayWebhook(
    @Headers("x-razorpay-signature") signature: string,
    @Body() body: any
  ) {
    if (!signature) throw new BadRequestException("MISSING_SIGNATURE");
    return this.payments.handleGatewayWebhook(signature, body);
  }

  /**
   * Escrow-condition webhook — called by Domain 3's release-gate when the
   * godown scan-count matches the manifest. INR payout mirrors the same
   * isReleasable() condition the on-chain Escrow enforces.
   */
  @Post("webhook/release-gate")
  @Public()
  @UsePipes(new ValidationPipe({ whitelist: false, forbidNonWhitelisted: false, transform: false }))
  releaseGate(
    @Headers("x-dtd-internal-signature") signature: string,
    @Body() body: { manifestId: string; bookingId: string; companyId: string }
  ) {
    return this.payments.handleReleaseGate(signature, body);
  }
}