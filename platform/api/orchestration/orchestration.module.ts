import { Module } from "@nestjs/common";
import { OrchestrationController } from "./orchestration.controller";
import { OrchestrationService } from "./orchestration.service";
import { BookingsModule } from "../bookings/bookings.module";
import { CustodyModule } from "../custody/custody.module";
import { GpsModule } from "../gps/gps.module";

/**
 * The composition root for cross-domain flows.
 *
 * DEPENDENCY DIRECTION — the whole point of this module:
 *
 *     OrchestrationModule ──> BookingsModule
 *                        ├──> CustodyModule
 *                        └──> GpsModule
 *
 * and NOTHING points back. No forwardRef(), no cycle, and each domain module
 * stays independently testable and independently mountable.
 *
 * The rejected alternative was to call CustodyService from BookingsService
 * (forward chain) and BookingsService from CustodyService (reverse chain),
 * which makes those two modules mutually dependent. forwardRef() would let
 * Nest boot that, but a cycle you can boot is still a cycle: it couples the
 * two domains permanently, and it invites exactly the kind of read-path state
 * mutation that the reverse chain originally used.
 *
 * All three imported modules already export their services, so nothing about
 * them changes to support this.
 */
@Module({
  imports: [BookingsModule, CustodyModule, GpsModule],
  controllers: [OrchestrationController],
  providers: [OrchestrationService],
  exports: [OrchestrationService],
})
export class OrchestrationModule {}
