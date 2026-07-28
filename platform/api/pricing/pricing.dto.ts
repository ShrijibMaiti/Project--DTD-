import { IsInt, IsNumber, IsString, Max, Min } from "class-validator";

export class EstimateDto {
  @IsNumber() @Min(-90) @Max(90)
  pickupLat!: number;

  @IsNumber() @Min(-180) @Max(180)
  pickupLng!: number;

  @IsNumber() @Min(-90) @Max(90)
  dropLat!: number;

  @IsNumber() @Min(-180) @Max(180)
  dropLng!: number;

  @IsString()
  truckType!: string;

  @IsInt() @Min(1)
  materialWeightKg!: number;
}