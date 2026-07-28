import { IsEnum, IsString, IsUUID } from "class-validator";

export class SubmitKycDto {
  @IsEnum(["OPERATOR_PAN", "OPERATOR_GST", "TRUCK_RC", "DRIVER_LICENSE", "AADHAAR_OFFLINE_XML"])
  docKind!: string;

  /** S3 object key of the uploaded document (PII stays in S3 + Postgres, never on-chain). */
  @IsString()
  storageKey!: string;

  /** What entity this document verifies. */
  @IsEnum(["TRANSPORTER", "TRUCK", "DRIVER"])
  subjectType!: "TRANSPORTER" | "TRUCK" | "DRIVER";

  @IsUUID()
  subjectId!: string;
}

export class ReviewKycDto {
  @IsEnum(["VERIFIED", "REJECTED"])
  decision!: "VERIFIED" | "REJECTED";

  @IsString()
  note!: string;
}