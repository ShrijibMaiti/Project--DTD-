import { IsInt, IsUUID, Max, Min } from "class-validator";

export class BuyPolicyDto {
  @IsUUID()
  bookingId!: string;

  /** Declared goods value; cover capped at ₹50,00,000. */
  @IsInt() @Min(10_000) @Max(5_000_000)
  declaredValueInr!: number;
}