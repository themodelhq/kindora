import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { IsEmail } from 'class-validator';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';

class DevEmailDto {
  @IsEmail()
  email: string;
}

/**
 * TEST-ONLY controller. Registered only when the process boots with
 * PROVIDER_MODE=mock — production binaries never mount this route at all,
 * so a mock-mode leak cannot be used to verify arbitrary emails.
 */
@Controller('auth/dev')
export class DevAuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('complete-verification')
  @HttpCode(200)
  completeVerification(@Body() dto: DevEmailDto) {
    return this.auth.devCompleteVerification(dto.email);
  }
}
