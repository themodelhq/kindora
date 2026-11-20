import { Module } from '@nestjs/common';
import { WithdrawalsService } from './withdrawals.service';
import { WithdrawalsController } from './withdrawals.controller';
import { ImpactLedgerModule } from '../ledger/impact-ledger.module';
import { PayoutsModule } from '../payouts/payouts.module';

@Module({
  imports: [ImpactLedgerModule, PayoutsModule],
  controllers: [WithdrawalsController],
  providers: [WithdrawalsService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
