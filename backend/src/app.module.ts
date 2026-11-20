import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import configuration from './common/config/configuration';
import { PrismaModule } from './common/prisma.module';
import { CoreModule } from './common/core.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { BigIntSerializerInterceptor } from './common/interceptors/bigint-serializer.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { ImpactLedgerModule } from './ledger/impact-ledger.module';
import { DonationsModule } from './donations/donations.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { UsersModule } from './users/users.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { StorageModule } from './storage/storage.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AiModule } from './ai/ai.module';
import { ModerationModule } from './moderation/moderation.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { BeneficiariesModule } from './beneficiaries/beneficiaries.module';
import { CirclesModule } from './circles/circles.module';
import { MatchingModule } from './matching/matching.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AdminModule } from './admin/admin.module';
import { FinancialModule } from './financial/financial.module';
import { MfaModule } from './mfa/mfa.module';
import { PayoutsModule } from './payouts/payouts.module';
import { InternalPayoutsModule } from './internal/internal-payouts.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], cache: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    CoreModule,
    HealthModule,
    AuthModule.forRoot(),
    ImpactLedgerModule,
    DonationsModule,
    WithdrawalsModule,
    UsersModule,
    CampaignsModule,
    StorageModule,
    AnalyticsModule,
    AiModule,
    ModerationModule,
    OrganizationsModule,
    BeneficiariesModule,
    CirclesModule,
    MatchingModule,
    NotificationsModule,
    AdminModule,
    FinancialModule,
    MfaModule,
    PayoutsModule,
    InternalPayoutsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: BigIntSerializerInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
