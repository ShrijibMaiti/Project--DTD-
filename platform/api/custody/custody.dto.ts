import {
  IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * A5 — address and hash validation is enforced HERE, not left to the domain.
 *
 * Previously these were bare @IsString(), so "hello" was an acceptable loader
 * address and would travel all the way to an on-chain write before failing —
 * or worse, succeed against a malformed address and anchor a manifest whose
 * signatures can never be produced. ManifestBuilder re-validates via Zod, but
 * by then the request has already been accepted.
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const PIECE_ID = /^DTD-[0-9A-HJ-NP-TV-Z]{10}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;

class PieceInputDto {
  @IsOptional() @Matches(PIECE_ID, { message: "pieceId must match DTD-XXXXXXXXXX" })
  pieceId?: string;

  @IsOptional() @IsString() sku?: string;
  @IsOptional() weightKg?: number;
}

export class CreateManifestDto {
  @IsUUID() bookingId!: string;

  @Matches(BYTES32, { message: "tripId must be a 0x-prefixed 32-byte hex string" })
  tripId!: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PieceInputDto)
  pieces?: PieceInputDto[];

  @IsOptional() @IsInt() @Min(1) pieceCount?: number;

  @Matches(ADDRESS, { message: "loader must be a 20-byte hex address" })
  loader!: string;

  @Matches(ADDRESS, { message: "driver must be a 20-byte hex address" })
  driver!: string;

  @Matches(ADDRESS, { message: "receiver must be a 20-byte hex address" })
  receiver!: string;
}

/**
 * A3 — scan context is no longer client-supplied.
 *
 * It used to be a free field on RecordScanDto, which meant a RECEIVER could
 * post context:"LOADING" and forge a loading-dock scan, and any authenticated
 * caller could post context:"PUBLIC_VERIFY" to pollute the double-scan net.
 * The context is now fixed by which ROUTE was called, and the route is gated
 * on the permission that matches the physical event.
 */
export class ScanDto {
  @Matches(PIECE_ID, { message: "pieceId must match DTD-XXXXXXXXXX" })
  pieceId!: string;

  @IsOptional() @Matches(BYTES32) manifestId?: string;

  /** Coarse only — DPDP. Precise coordinates are stripped downstream. */
  @IsOptional() @IsString() locationHint?: string;

  /** Idempotency key for the offline scanner queue. */
  @IsOptional() @IsString() clientNonce?: string;
}

export class ScanBatchDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ScanDto)
  scans!: ScanDto[];
}

/**
 * A2 — the receiver signs for the count they ACTUALLY got.
 *
 * Note what is absent: there is no `count` field. The scanned count is
 * derived server-side from reconciliation, never supplied by the client.
 * Letting a receiver post "I got 200" while 175 were scanned would defeat the
 * entire purpose of the money seam.
 */
export class ConfirmDeliveryDto {
  @Matches(E164, { message: "receiverPhone must be E.164, e.g. +919000000000" })
  receiverPhone!: string;

  @IsString() otpToken!: string;
}

/** Issued before ConfirmDeliveryDto — sends the receiver their code. */
export class RequestDeliveryOtpDto {
  @Matches(E164, { message: "receiverPhone must be E.164, e.g. +919000000000" })
  receiverPhone!: string;
}

/** Retained for the legacy combined-scan route during migration. */
export class RecordScanDto extends ScanDto {
  @IsIn(["LOADING", "UNLOADING", "PUBLIC_VERIFY", "PARTNER"]) context!: string;
}
