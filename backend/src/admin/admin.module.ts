import { Module } from '@nestjs/common';
import { ImpactLedgerModule } from '../ledger/impact-ledger.module';
import { DonationsModule } from '../donations/donations.module';
import { StorageModule } from '../storage/storage.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [ImpactLedgerModule, DonationsModule, StorageModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
