import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  firstName: string;
  lastName: string;
  emailVerified: boolean;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedUser | null => {
  const request = ctx.switchToHttp().getRequest<Request>();
  return (request as Request & { user?: AuthenticatedUser }).user ?? null;
});

export const ClientIp = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request>();
  return (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? request.ip ?? 'unknown';
});
