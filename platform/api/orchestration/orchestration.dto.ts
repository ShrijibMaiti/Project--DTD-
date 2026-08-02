import {
  IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Min, ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PIECE_ID = /^DTD-[0-9A-HJ-NP-TV-Z]{10}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;

class PieceInputDto {
  @IsOptional() @Matches(PIECE_ID) pieceId?: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() weightKg?: number;
}

/**
 * Start a trip: assign truck + driver, optionally create the custody manifest,
 * optionally bind the GPS device — in one transaction.
 *
 * NOTE what is absent: tripId. It is derived server-side and deterministically
 * from the bookingId, so a retried request cannot mint a second trip identity
 * for the same booking. A client-supplied tripId would defeat that.
 */
export class StartTripDto {
  @IsUUID() truckId!: string;
  @IsUUID() driverId!: string;

  /**
   * Custody participants. Optional: without them the trip still starts, and
   * the response reports custody as skipped with a reason rather than
   * failing. The driver's address is NOT accepted here — it is read from
   * drivers.signing_address, because a caller-supplied driver address would
   * let a dispatcher nominate any signer they liked.
   */
  @IsOptional() @Matches(ADDRESS, { message: "loader must be a 20-byte hex address" })
  loader?: string;

  @IsOptional() @Matches(ADDRESS, { message: "receiver must be a 20-byte hex address" })
  receiver?: string;

  @IsOptional() @IsInt() @Min(1) pieceCount?: number;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PieceInputDto)
  pieces?: PieceInputDto[];
}

/**
 * Confirm delivery: the receiver signs for the count that was actually
 * scanned, and the booking transitions as a consequence.
 *
 * Again, no count field — it is derived from reconciliation server-side.
 */
export class ConfirmTripDeliveryDto {
  @Matches(E164, { message: "receiverPhone must be E.164, e.g. +919000000000" })
  receiverPhone!: string;

  @IsString() otpToken!: string;
}
