import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { CommonModule } from "./common/common.module";
import { TenantMiddleware } from "./common/tenant.middleware";
import { BookingsModule } from "./bookings/bookings.module";
import { PricingModule } from "./pricing/pricing.module";
import { FleetModule } from "./fleet/fleet.module";
import { KycModule } from "./kyc/kyc.module";
import { InsuranceModule } from "./insurance/insurance.module";
import { PaymentsModule } from "./payments/payments.module";
import { DocumentsModule } from "./documents/documents.module";
import { ClaimsModule } from "./claims/claims.module";
import { SupportModule } from "./support/support.module";

@Module({
  imports: [
    CommonModule,
    BookingsModule,
    PricingModule,
    FleetModule,
    KycModule,
    InsuranceModule,
    PaymentsModule,
    DocumentsModule,
    ClaimsModule,
    SupportModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}