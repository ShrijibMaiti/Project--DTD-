import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class CreateTicketDto {
  @IsOptional() @IsUUID()
  bookingId?: string;

  @IsEnum(["BOOKING", "PAYMENT", "DOCUMENT", "TRACKING", "OTHER"])
  category!: string;

  @IsString() @MaxLength(200)
  subject!: string;

  @IsString() @MaxLength(5000)
  message!: string;
}

export class ReplyTicketDto {
  @IsString() @MaxLength(5000)
  message!: string;
}