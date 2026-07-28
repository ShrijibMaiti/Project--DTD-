import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
  ArrayMinSize,
} from "class-validator";
import { Type } from "class-transformer";

export class StopDto {
  @IsEnum(["PICKUP", "DROP"])
  kind!: "PICKUP" | "DROP";

  @IsString()
  address!: string;

  @IsNumber() @Min(-90) @Max(90)
  lat!: number;

  @IsNumber() @Min(-180) @Max(180)
  lng!: number;

  @IsInt() @Min(0)
  sequence!: number;
}

export class CreateBookingDto {
  @IsUUID()
  quoteId!: string;

  @IsString()
  truckType!: string;

  @IsInt() @Min(1)
  materialWeightKg!: number;

  /** Advance scheduling: planned dispatch date/time. */
  @IsDateString()
  scheduledAt!: string;

  /** Multi-point pickup and drop. */
  @IsArray() @ArrayMinSize(2) @ValidateNested({ each: true }) @Type(() => StopDto)
  stops!: StopDto[];

  @IsOptional() @IsString()
  notes?: string;
}

export class AssignTruckDto {
  @IsUUID()
  truckId!: string;

  @IsUUID()
  driverId!: string;
}

export class CancelBookingDto {
  @IsOptional() @IsString()
  reason?: string;
}