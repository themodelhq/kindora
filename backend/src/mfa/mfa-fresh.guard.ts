import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { MfaPurpose, MfaService } from './mfa.service';

export { MfaPurpose };

export const MFA_METADATA_KEY = 'kindora:require-mfa';

export interface RequireMfaOptions {
  purpose: MfaPurpose;
  /**
   * How to bind the challenge scope:
   *  - 'params.id'      -> route :id (withdrawal routes)
   *  - 'body.<field>'   -> a request body field (e.g. body.donationId)
   *  - null/undefined   -> global scope (no resource binding)
   */
  scopeFrom?: string | null;
}

export const MFA_HEADER = 'x-mfa-challenge';

/** Decorator marking an endpoint as requiring FRESH MFA (single-use challenge). */
export const RequireMfa = (purpose: MfaPurpose, scopeFrom: string | null = 'params.id') =>
  ((target: object, propertyKey?: string | symbol, descriptor?: TypedPropertyDescriptor<unknown>) => {
    const options: RequireMfaOptions = { purpose, scopeFrom: scopeFrom ?? null };
    if (descriptor) {
      Reflect.defineMetadata(MFA_METADATA_KEY, options, descriptor.value as object);
      return descriptor;
    }
    Reflect.defineMetadata(MFA_METADATA_KEY, options, target);
    return target;
  }) as MethodDecorator & ClassDecorator;

/** Minimal dotted-path resolver for scope extraction. */
function resolvePath(source: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[part];
      }
      return undefined;
    }, source);
}

/**
 * Consumes a fresh MFA challenge bound to (user, purpose, scope).
 *
 * Must run AFTER JwtAuthGuard (global order: Throttler -> JwtAuth -> Roles -> MFA),
 * so `request.user` is always populated here.
 *
 * Fail-closed: when the challenge backend (Redis) is unavailable the operation
 * is rejected with 503 — there is no bypass path.
 */
@Injectable()
export class MfaFreshGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly mfa: MfaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<RequireMfaOptions | undefined>(MFA_METADATA_KEY, context.getHandler());
    if (!options) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: { id: string } }>();
    const user = request.user;
    if (!user?.id) {
      throw new ForbiddenException('Fresh MFA requires an authenticated user');
    }

    const scope = options.scopeFrom
      ? ((resolvePath({ params: request.params, body: request.body, query: request.query }, options.scopeFrom) as string | undefined) ?? null)
      : null;

    const header = request.headers[MFA_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token) {
      throw new ForbiddenException(
        `Fresh MFA verification required for this operation (purpose: ${options.purpose}). ` +
          'Exchange a current TOTP code via POST /mfa/challenge and send the token in the x-mfa-challenge header.',
      );
    }

    await this.mfa.consumeChallenge(user.id, options.purpose, scope, token);
    return true;
  }
}
