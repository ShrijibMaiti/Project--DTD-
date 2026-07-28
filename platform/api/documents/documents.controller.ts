import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { DocumentsService } from "./documents.service";
import { GenerateDocumentDto } from "./documents.dto";
import { TenantRequest } from "../common/tenant.middleware";

@Controller("documents")
export class DocumentsController {
  constructor(private documents: DocumentsService) {}

  /** Generate -> store -> hash -> anchor on-chain -> WhatsApp the link. */
  @Post("generate")
  generate(@Req() req: TenantRequest, @Body() dto: GenerateDocumentDto) {
    return this.documents.generate(req.companyId, req.userId, dto);
  }

  @Get("booking/:bookingId")
  list(@Req() req: TenantRequest, @Param("bookingId", ParseUUIDPipe) bookingId: string) {
    return this.documents.listForBooking(req.companyId, bookingId);
  }
}