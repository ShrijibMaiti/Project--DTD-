import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { CustodyService } from "./custody.service";
import {
  CreateManifestDto, ScanDto, ScanBatchDto, ConfirmDeliveryDto,
  RequestDeliveryOtpDto,
} from "./custody.dto";
import { TenantRequest } from "../common/request.types";
import {
  RequiresPermission, RequiresAnyPermission, RequiresModule,
} from "@dtd/identity/rbac/guards";
import { Permission } from "@dtd/shared/roles.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";
import { ScanContext } from "@dtd/shared/scan-event.schema";

@Controller("custody")
@RequiresModule(PlatformModule.CUSTODY_TRACKING)
export class CustodyController {
  constructor(private custody: CustodyService) {}

  // ================================================================
  // Manifests
  // ================================================================

  @Post("manifests")
  @RequiresPermission(Permission.MANIFEST_CREATE)
  createManifest(@Req() req: TenantRequest, @Body() dto: CreateManifestDto) {
    return this.custody.createManifest(req.companyId, req.userId, dto);
  }

  /**
   * TRACKING_VIEW is the closest existing semantic ("where's my shipment").
   * Carried over from the original implementation; still worth a second look
   * if a dedicated MANIFEST_READ permission is ever added.
   */
  @Get("manifests/:manifestId")
  @RequiresPermission(Permission.TRACKING_VIEW)
  getManifest(@Req() req: TenantRequest, @Param("manifestId") manifestId: string) {
    return this.custody.getManifest(req.companyId, manifestId);
  }

  @Get("manifests/:manifestId/status")
  @RequiresPermission(Permission.TRACKING_VIEW)
  getCustodyStatus(@Req() req: TenantRequest, @Param("manifestId") manifestId: string) {
    return this.custody.getCustodyStatus(req.companyId, manifestId);
  }

  @Get("manifests/:manifestId/attribution")
  @RequiresPermission(Permission.CLAIMS_PACKET_BUILD)
  getAttribution(@Req() req: TenantRequest, @Param("manifestId") manifestId: string) {
    return this.custody.getAttribution(req.companyId, manifestId);
  }

  // ================================================================
  // A4 — reconciliation
  // ================================================================

  /**
   * 175/200 and the names of the missing 25.
   *
   * RequiresAnyPermission, not a split route: this is ONE fact that two roles
   * legitimately need. The RECEIVER must see the shortage before signing for
   * it (SHORTAGE_REPORT); an ADMIN or DISPATCHER must see it to work the
   * exception (TRACKING_VIEW). Neither role holds the other's permission, and
   * duplicating the route would mean two URLs returning identical data.
   */
  @Get("manifests/:manifestId/reconcile")
  @RequiresAnyPermission(Permission.SHORTAGE_REPORT, Permission.TRACKING_VIEW)
  reconcile(@Req() req: TenantRequest, @Param("manifestId") manifestId: string) {
    return this.custody.reconcile(req.companyId, manifestId);
  }

  /** Read-only release check. Safe to poll — makes no chain writes. */
  @Get("manifests/:manifestId/release-status")
  @RequiresAnyPermission(Permission.SHORTAGE_REPORT, Permission.PAYMENT_READ)
  releaseStatus(@Req() req: TenantRequest, @Param("manifestId") manifestId: string) {
    return this.custody.evaluateRelease(req.companyId, manifestId);
  }

  // ================================================================
  // A2 — delivery confirmation
  // ================================================================

  /** Step 1: mint the receiver's key if needed, send their OTP. */
  @Post("manifests/:manifestId/delivery-otp")
  @RequiresPermission(Permission.DELIVERY_CONFIRM)
  requestDeliveryOtp(
    @Req() req: TenantRequest,
    @Param("manifestId") manifestId: string,
    @Body() dto: RequestDeliveryOtpDto
  ) {
    return this.custody.requestDeliveryOtp(req.companyId, manifestId, dto);
  }

  /**
   * Step 2: the receiver signs for what actually arrived.
   *
   * THE MONEY SEAM. The scanned count is computed server-side and submitted
   * on-chain as-is — the client cannot assert a count. A short delivery
   * records as Short and freezes payment.
   *
   * This is also the correct trigger for the booking status transition in
   * Phase B orchestration. It is a write, it happens exactly once, and it
   * happens at the moment delivery becomes final — unlike a GET handler,
   * which only fires if somebody happens to be looking.
   */
  @Post("manifests/:manifestId/confirm-delivery")
  @RequiresPermission(Permission.DELIVERY_CONFIRM)
  confirmDelivery(
    @Req() req: TenantRequest,
    @Param("manifestId") manifestId: string,
    @Body() dto: ConfirmDeliveryDto
  ) {
    return this.custody.confirmDelivery(req.companyId, req.userId, manifestId, dto);
  }

  // ================================================================
  // A3 — scans, split by physical event
  // ================================================================

  /**
   * Loading dock. The DRIVER accepting custody of N pieces.
   *
   * Split from the old shared POST /custody/scans, which was gated on the
   * module only because DRIVER (CUSTODY_SIGN) and RECEIVER (SCAN_SUBMIT) hold
   * different permissions and @RequiresPermission checks one. Splitting is the
   * right fix here rather than an OR: these are genuinely different events at
   * different ends of the custody chain, and the context can no longer be
   * spoofed through the request body.
   */
  @Post("scans/loading")
  @RequiresPermission(Permission.CUSTODY_SIGN)
  scanLoading(@Req() req: TenantRequest, @Body() dto: ScanDto) {
    return this.custody.recordScan(
      req.companyId, req.userId, ScanContext.LOADING, dto
    );
  }

  @Post("scans/loading/batch")
  @RequiresPermission(Permission.CUSTODY_SIGN)
  scanLoadingBatch(@Req() req: TenantRequest, @Body() dto: ScanBatchDto) {
    return this.custody.recordScanBatch(
      req.companyId, req.userId, ScanContext.LOADING, dto.scans
    );
  }

  /** Godown scan-in. The RECEIVER counting what actually arrived. */
  @Post("scans/unloading")
  @RequiresPermission(Permission.SCAN_SUBMIT)
  scanUnloading(@Req() req: TenantRequest, @Body() dto: ScanDto) {
    return this.custody.recordScan(
      req.companyId, req.userId, ScanContext.UNLOADING, dto
    );
  }

  /** Offline PWA queue flush. Idempotent per clientNonce. */
  @Post("scans/unloading/batch")
  @RequiresPermission(Permission.SCAN_SUBMIT)
  scanUnloadingBatch(@Req() req: TenantRequest, @Body() dto: ScanBatchDto) {
    return this.custody.recordScanBatch(
      req.companyId, req.userId, ScanContext.UNLOADING, dto.scans
    );
  }

  @Get("pieces/:pieceId/history")
  @RequiresPermission(Permission.TRACKING_VIEW)
  getPieceHistory(@Req() req: TenantRequest, @Param("pieceId") pieceId: string) {
    return this.custody.getPieceHistory(req.companyId, pieceId);
  }
}
