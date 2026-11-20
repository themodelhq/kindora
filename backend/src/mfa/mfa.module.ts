import { Global, Module } from '@nestjs/common';
import { MfaService } from './mfa.service';
import { MfaFreshGuard, MFA_HEADER, MFA_METADATA_KEY, RequireMfa, type RequireMfaOptions } from './mfa-fresh.guard';
import { MfaController, MfaChallengeDto, MfaConfirmDto } from './mfa.controller';
import { MfaPurpose } from './mfa.service';

/**
 * Fresh-MFA module (v1.0.4 §7). Global module so any feature module can use
 * MfaService / RequireMfa without re-declaring providers.
 */
@Global()
@Module({
  providers: [MfaService, MfaFreshGuard],
  controllers: [MfaController],
  exports: [MfaService, MfaFreshGuard],
})
export class MfaModule {}

export { MfaService, MfaPurpose, MfaFreshGuard, MFA_HEADER, MFA_METADATA_KEY, RequireMfa, MfaController, MfaChallengeDto, MfaConfirmDto };
export type { RequireMfaOptions };
