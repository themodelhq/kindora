import { Module } from '@nestjs/common';
import { FinancialController } from './financial.controller';
import { FinancialService } from './financial.service';

/**
 * Financial Control & Reconciliation Centre (hardening spec §9).
 *
 * Read-only module: aggregates donations, webhooks, withdrawals, refunds and
 * the double-entry ledger into admin-only control views. PrismaService is
 * provided by the global PrismaModule, so no additional imports are needed.
 */
@Module({
  controllers: [FinancialController],
  providers: [FinancialService],
})
export class FinancialModule {}
