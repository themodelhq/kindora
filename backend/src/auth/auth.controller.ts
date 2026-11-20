import { Body, Controller, Get, HttpCode, Ip, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import type { Request, Response } from 'express';

class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(10, { message: 'Password must be at least 10 characters' })
  @Matches(/[A-Z]/, { message: 'Password must contain an uppercase letter' })
  @Matches(/[0-9]/, { message: 'Password must contain a digit' })
  password: string;

  @IsString()
  firstName: string;

  @IsString()
  lastName: string;
}

class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}

class TokenDto {
  // Optional: the primary transport for the refresh token is the httpOnly
  // cookie; a body token is only accepted as a fallback for server-to-server
  // use. An empty body must NOT 400 — the browser silent-refresh flow posts
  // with cookies only.
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

class VerifyEmailDto {
  @IsString()
  token: string;
}

class ForgotPasswordDto {
  @IsEmail()
  email: string;
}

class ResetPasswordDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(10)
  @Matches(/[A-Z]/)
  @Matches(/[0-9]/)
  password: string;
}

const REFRESH_COOKIE = 'kindora_refresh';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  private cookieOptions() {
    const isProd = this.config.get('env') === 'production';
    return {
      httpOnly: true,
      secure: isProd,
      sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
      maxAge: (this.config.get<number>('jwt.refreshTtlDays') ?? 30) * 24 * 3600 * 1000,
      path: '/api/v1/auth',
    };
  }

  private meta(req: Request) {
    return {
      userAgent: req.headers['user-agent'],
      // With `trust proxy` set, req.ip is the real client address; the
      // client-supplied X-Forwarded-For header is deliberately NOT trusted
      // (spoofable) for security-relevant metadata.
      ip: req.ip,
    };
  }

  /**
   * CSRF defence for the cookie-consuming endpoints (refresh / logout).
   * Layers:
   *  1. Origin allowlist when CORS_ORIGINS is configured — in production a
   *     missing/empty CORS_ORIGINS is a configuration error, so requests WITH
   *     an Origin header that cannot be verified are rejected (fail closed).
   *  2. Sec-Fetch-Site header (modern browsers always send it): cross-site
   *     initiator requests are rejected. This complements SameSite=None,
   *     which alone does not defend against CSRF.
   * Non-browser clients (no Origin, no Sec-Fetch-Site) still pass so
   * curl/server-to-server flows keep working.
   */
  private assertOrigin(req: Request) {
    const origins: string[] = this.config.get('corsOrigins') ?? [];
    const isProd = this.config.get('env') === 'production';
    const origin = req.headers.origin as string | undefined;
    if (origin) {
      if (origins.length === 0) {
        if (isProd) throw new UnauthorizedException('Origin verification is not configured (CORS_ORIGINS empty in production)');
      } else if (!origins.includes(origin)) {
        throw new UnauthorizedException('Origin not allowed');
      }
    }
    const fetchSite = req.headers['sec-fetch-site'] as string | undefined;
    if (fetchSite === 'cross-site') {
      throw new UnauthorizedException('Cross-site request rejected');
    }
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  @HttpCode(201)
  async register(@Body() dto: RegisterDto, @Ip() ip: string) {
    return { user: await this.auth.register(dto.email, dto.password, dto.firstName, dto.lastName, ip) };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tokens = await this.auth.login(dto.email, dto.password, this.meta(req));
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, this.cookieOptions());
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() dto?: TokenDto) {
    this.assertOrigin(req);
    const token = req.cookies?.[REFRESH_COOKIE] ?? dto?.refreshToken;
    if (!token) throw new UnauthorizedException('Missing refresh token');
    const tokens = await this.auth.refresh(token, this.meta(req));
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, this.cookieOptions());
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() dto?: TokenDto) {
    this.assertOrigin(req);
    const token = req.cookies?.[REFRESH_COOKIE] ?? dto?.refreshToken;
    await this.auth.logout(token);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    return { ok: true };
  }

  @Public()
  @Post('verify-email')
  @HttpCode(200)
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto.token);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(200)
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('reset-password')
  @HttpCode(200)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.password);
  }

  @Get('me')
  async me(@Req() req: Request) {
    return { user: (req as Request & { user: object }).user };
  }
}
