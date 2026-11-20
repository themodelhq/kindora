import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { ImpactLedgerController } from './impact-ledger.controller';

@Module({
  providers: [LedgerService],
  controllers: [ImpactLedgerController],
  exports: [LedgerService],
})
export class ImpactLedgerModule {}
