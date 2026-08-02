import { Module } from "@nestjs/common";
import { CustodyController } from "./custody.controller";
import { CustodyService } from "./custody.service";
import { ParticipantsResolver } from "./participants.resolver";

/**
 * ParticipantsResolver is exported but not yet consumed by any route — it is
 * the seam Phase B orchestration plugs into. Registering it here rather than
 * in the future OrchestrationModule keeps address resolution owned by the
 * domain that defines what a valid participant is.
 */
@Module({
  controllers: [CustodyController],
  providers: [CustodyService, ParticipantsResolver],
  exports: [CustodyService, ParticipantsResolver],
})
export class CustodyModule {}
