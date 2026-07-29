import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { DocumentsService } from "./documents.service";
import { GenerateDocumentDto } from "./documents.dto";
import { TenantRequest } from "../common/request.types";
import { RequiresPermission, RequiresModule } from "@dtd/identity/rbac/guards";
import { Permission } from "@dtd/shared/roles.schema";
import { PlatformModule } from "@dtd/shared/modules.schema";

@Controller("documents")
@RequiresModule(PlatformModule.DOCUMENTS)
export class DocumentsController {
  constructor(private documents: DocumentsService) {}

  /** Generate -> store -> hash -> anchor on-chain -> WhatsApp the link. */
  @Post("generate")
  @RequiresPermission(Permission.DOCUMENT_GENERATE)
  generate(@Req() req: TenantRequest, @Body() dto: GenerateDocumentDto) {
    return this.documents.generate(req.companyId, req.userId, dto);
  }

  @Get("booking/:bookingId")
  @RequiresPermission(Permission.DOCUMENT_READ)
  list(@Req() req: TenantRequest, @Param("bookingId", ParseUUIDPipe) bookingId: string) {
    return this.documents.listForBooking(req.companyId, bookingId);
  }
}