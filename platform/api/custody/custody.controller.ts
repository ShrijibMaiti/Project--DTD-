import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { CustodyService } from "./custody.service";
import { CreateManifestDto, RecordScanDto, RecordScanBatchDto } from "./custody.dto";
import { TenantRequest } from "../common/request.types";
import { RequiresPermission, RequiresModule } from "@dtd/identity/rbac/guards";
import { Permission } from "@dtd/shared/roles.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";

@Controller("custody")
@RequiresModule(PlatformModule.CUSTODY_TRACKING)
export class CustodyController {
  constructor(private custody: CustodyService) {}

  @Post("manifests")
  @RequiresPermission(Permission.MANIFEST_CREATE)
  createManifest(@Req() req: TenantRequest, @Body() dto: CreateManifestDto) {
    return this.custody.createManifest(req.companyId, req.userId, dto);
  }

  /**
   * No dedicated Permission exists for "read a manifest" in roles.schema.ts.
   * Using TRACKING_VIEW — closest existing semantic match ("where's my
   * shipment"), same permission GPS tracking uses. Flagged for review rather
   * than silently picked; happy to swap once you confirm the right fit.
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

  /**
   * Shared by DRIVER (loading/transit scans, has CUSTODY_SIGN) and RECEIVER
   * (unloading scans, has SCAN_SUBMIT) — neither role holds both
   * permissions, and @RequiresPermission only checks one. Gated on the
   * module only for now; flagged in the audit response as needing either an
   * OR-capable guard or a split into two routes. Not silently narrowed to
   * one role's permission, which would lock the other role out entirely.
   */
  @Post("scans")
  recordScan(@Req() req: TenantRequest, @Body() dto: RecordScanDto) {
    return this.custody.recordScan(req.companyId, req.userId, dto);
  }

  @Get("pieces/:pieceId/history")
  @RequiresPermission(Permission.TRACKING_VIEW)
  getPieceHistory(@Req() req: TenantRequest, @Param("pieceId") pieceId: string) {
    return this.custody.getPieceHistory(req.companyId, pieceId);
  }
}
