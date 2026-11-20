import { Module } from '@nestjs/common';
import { ModerationController } from './moderation.controller';
import { ModerationService } from './moderation.service';
import { FraudRuleService } from './fraud-rules.service';

@Module({
  controllers: [ModerationController],
  providers: [ModerationService, FraudRuleService],
  exports: [ModerationService, FraudRuleService],
})
export class ModerationModule {}
