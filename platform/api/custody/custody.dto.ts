import {
  IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Min, ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

class PieceInputDto {
  @IsOptional() @IsString() pieceId?: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() weightKg?: number;
}

export class CreateManifestDto {
  @IsUUID() bookingId!: string;
  @IsString() tripId!: string; // bytes32 hex, validated again in ManifestBuilder

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PieceInputDto)
  pieces?: PieceInputDto[];

  @IsOptional() @IsInt() @Min(1) pieceCount?: number;

  @IsString() loader!: string;
  @IsString() driver!: string;
  @IsString() receiver!: string;
}

export class RecordScanDto {
  @IsString() pieceId!: string;
  @IsOptional() @IsString() manifestId?: string;
  @IsIn(["LOADING", "UNLOADING", "PUBLIC_VERIFY", "PARTNER"]) context!: string;
  @IsOptional() @IsString() locationHint?: string;
  @IsOptional() @IsString() clientNonce?: string;
}

export class RecordScanBatchDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => RecordScanDto)
  scans!: RecordScanDto[];
}
