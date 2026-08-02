import { Module } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { CommonModule } from "./common/common.module";
import { RbacModule } from "@dtd/identity/rbac/rbac.module";
import { DtdAuthGuard } from "@dtd/identity/rbac/guards";
import { BookingsModule } from "./bookings/bookings.module";
import { PricingModule } from "./pricing/pricing.module";
import { FleetModule } from "./fleet/fleet.module";
import { KycModule } from "./kyc/kyc.module";
import { InsuranceModule } from "./insurance/insurance.module";
import { PaymentsModule } from "./payments/payments.module";
import { DocumentsModule } from "./documents/documents.module";
import { ClaimsModule } from "./claims/claims.module";
import { SupportModule } from "./support/support.module";
import { CustodyModule } from "./custody/custody.module";
import { GpsModule } from "./gps/gps.module";
import { OrchestrationModule } from "./orchestration/orchestration.module";

/**
 * DtdAuthGuard is registered GLOBALLY, not as middleware.
 *
 * This is the important design choice: a global guard means every route is
 * protected BY DEFAULT and an unguarded endpoint requires an explicit
 * @Public() decorator. The previous middleware approach failed open — forget
 * to apply it and the route was wide open. This fails closed.
 *
 * TenantMiddleware is gone entirely; the guard sets req.actor instead.
 *
 * OrchestrationModule is listed last because it depends on Bookings, Custody
 * and GPS. Nest resolves the graph regardless of order, but the ordering
 * documents the layering: domains first, composition on top.
 */
@Module({
  imports: [
    CommonModule,
    RbacModule,
    BookingsModule,
    PricingModule,
    FleetModule,
    KycModule,
    InsuranceModule,
    PaymentsModule,
    DocumentsModule,
    ClaimsModule,
    SupportModule,
    CustodyModule,
    GpsModule,
    OrchestrationModule,
  ],
  providers: [
    Reflector,
    { provide: APP_GUARD, useClass: DtdAuthGuard },
  ],
})
export class AppModule {}
