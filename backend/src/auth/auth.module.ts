import { Global, DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { DevAuthController } from './dev-auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';

@Global()
@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret') ?? 'dev-only-secret-change-me',
        signOptions: { expiresIn: config.get<number>('jwt.accessTtlSeconds') ?? 900 },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard, RolesGuard],
  exports: [AuthService, JwtModule, JwtAuthGuard, RolesGuard],
})
export class AuthModuleStatic {}

/**
 * The test-only dev controller (instant email verification) is mounted ONLY
 * when the process runs in mock mode. A production binary never exposes it.
 */
@Global()
@Module({})
export class AuthModule {
  static forRoot(): DynamicModule {
    const mockMode = (process.env.PROVIDER_MODE ?? 'live').toLowerCase() === 'mock';
    return {
      module: AuthModuleStatic,
      global: true,
      imports: [
        PassportModule,
        JwtModule.registerAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            secret: config.get<string>('jwt.secret') ?? 'dev-only-secret-change-me',
            signOptions: { expiresIn: config.get<number>('jwt.accessTtlSeconds') ?? 900 },
          }),
        }),
      ],
      controllers: mockMode ? [AuthController, DevAuthController] : [AuthController],
      providers: [AuthService, JwtStrategy, JwtAuthGuard, RolesGuard],
      exports: [AuthService, JwtModule, JwtAuthGuard, RolesGuard],
    };
  }
}
