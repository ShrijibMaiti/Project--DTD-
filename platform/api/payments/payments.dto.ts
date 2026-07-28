import { IsEnum, IsInt, IsUUID, Min } from "class-validator";

export class CreateCollectionDto {
  @IsUUID()
  bookingId!: string;

  @IsInt() @Min(1)
  amountInr!: number;

  @IsEnum(["UPI", "NEFT", "IMPS", "NETBANKING"])
  method!: "UPI" | "NEFT" | "IMPS" | "NETBANKING";
}