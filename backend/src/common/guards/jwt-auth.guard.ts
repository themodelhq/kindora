import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import type { Request } from 'express';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      // Public route, but attach the user if a valid bearer token is present
      // (enables logged-in donations, tracking, etc.).
      const authHeader = request.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) return true;
      try {
        const payload = await this.jwtService.verifyAsync(authHeader.slice(7));
        const user = await this.prisma.user.findUnique({
          where: { id: payload.sub },
          select: { id: true, email: true, role: true, status: true, firstName: true, lastName: true, emailVerifiedAt: true },
        });
        if (user && user.status === 'ACTIVE') {
          (request as Request & { user?: AuthenticatedUser }).user = {
            id: user.id,
            email: user.email,
            role: user.role,
            firstName: user.firstName,
            lastName: user.lastName,
            emailVerified: user.emailVerifiedAt !== null,
          };
        }
      } catch {
        // Invalid token on a public route: treat as anonymous.
      }
      return true;
    }

    const authHeader = request.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');

    const token = authHeader.slice(7);
    let payload: { sub: string; email: string };
    try {
      payload = await this.jwtService.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, status: true, firstName: true, lastName: true, emailVerifiedAt: true },
    });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Account unavailable');

    (request as Request & { user?: AuthenticatedUser }).user = {
      id: user.id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      emailVerified: user.emailVerifiedAt !== null,
    };
    return true;
  }
}
