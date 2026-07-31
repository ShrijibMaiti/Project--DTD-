import {
  IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, Min, IsArray, ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class RegisterDeviceDto {
  @IsString() deviceId!: string;
  @IsUUID() truckId!: string;
  @IsString() sharedSecret!: string;
}

export class RotateSecretDto {
  @IsString() newSecret!: string;
}

export class StartTripDto {
  @IsString() tripId!: string; // bytes32 hex, validated downstream
}

// ---------------------------------------------------------------- ingest
// @Public() — no JWT. Kept permissive by design: a malformed device payload
// should reach IngestGateway's own reject-with-reason path, not a generic 400.

export class IngestPingDto {
  @IsString() deviceId!: string;
  @IsNumber() lat!: number;
  @IsNumber() lng!: number;
  @IsInt() ts!: number;
  @IsOptional() @IsNumber() speedKph?: number;
  @IsOptional() @IsNumber() headingDeg?: number;
  @IsOptional() @IsString() deviceMac?: string;
}

export class IngestBatchDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => IngestPingDto)
  pings!: IngestPingDto[];
}

// ---------------------------------------------------------------- reads

export class WasVehicleNearDto {
  @IsNumber() lat!: number;
  @IsNumber() lng!: number;
  @IsInt() ts!: number;
  @IsNumber() @Min(1) @Max(50_000) radiusM!: number;
}
