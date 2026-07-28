import { IsEnum, IsInt, IsOptional, IsString, Matches, Min } from "class-validator";

export class CreateTruckDto {
  /** Indian registration format, e.g. WB12AB1234 */
  @Matches(/^[A-Z]{2}\d{2}[A-Z]{1,2}\d{4}$/)
  regNumber!: string;

  @IsString()
  truckType!: string;

  @IsInt() @Min(100)
  capacityKg!: number;

  @IsOptional() @IsString()
  gpsDeviceId?: string;
}

export class CreateDriverDto {
  @IsString()
  fullName!: string;

  /** E.164 — this phone becomes the driver's signing identity (Domain 2 keys). */
  @Matches(/^\+91\d{10}$/)
  phone!: string;

  @IsString()
  licenseNumber!: string;
}

export class SetTruckStatusDto {
  @IsEnum(["AVAILABLE", "ON_TRIP", "MAINTENANCE", "INACTIVE"])
  status!: "AVAILABLE" | "ON_TRIP" | "MAINTENANCE" | "INACTIVE";
}