import { Module } from "@nestjs/common";
import { ClaimsController } from "./claims.controller";
import { ClaimsService } from "./claims.service";

@Module({
  controllers: [ClaimsController],
  providers: [ClaimsService],
})
export class ClaimsModule {}