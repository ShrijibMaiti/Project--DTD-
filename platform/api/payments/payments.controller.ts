import {
  BadRequestException, Body, Controller, Get, Headers, Param,
  ParseUUIDPipe, Post, Req, UsePipes, ValidationPipe,
} from "@nestjs/common";
import { PaymentsService } from "./payments.service";
import { CreateCollectionDto } from "./payments.dto";
import { TenantRequest } from "../common/tenant.middleware";

@Controller("payments")
export class PaymentsController {
  constructor(private payments: PaymentsService) {}

  /** Payment is due when the vehicle reaches the loading point. */
  @Post("collect")
  collect(@Req() req: TenantRequest, @Body() dto: CreateCollectionDto) {
    return this.payments.createCollection(req.transporterId, req.userId, dto);
  }

  @Get(":bookingId")
  get(@Req() req: TenantRequest, @Param("bookingId", ParseUUIDPipe) bookingId: string) {
    return this.payments.getByBooking(req.transporterId, bookingId);
  }

  /** Gateway webhook — authenticated by HMAC signature, NOT bearer token. */
  @Post("webhook/gateway")
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
  @UsePipes(new ValidationPipe({ whitelist: false, forbidNonWhitelisted: false, transform: false }))
  releaseGate(
    @Headers("x-dtd-internal-signature") signature: string,
    @Body() body: { manifestId: string; bookingId: string; transporterId: string }
  ) {
    return this.payments.handleReleaseGate(signature, body);
  }
}