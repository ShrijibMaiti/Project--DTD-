import { IsEnum, IsObject, IsUUID } from "class-validator";

export class GenerateDocumentDto {
  @IsUUID()
  bookingId!: string;

  @IsEnum(["BILTY", "POD", "INVOICE"])
  docType!: "BILTY" | "POD" | "INVOICE";

  /** Structured content that renders into the PDF (consignor, consignee, items…). */
  @IsObject()
  payload!: Record<string, unknown>;
}