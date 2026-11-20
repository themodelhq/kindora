import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Converts BigInt values to strings so JSON serialization never throws.
 * Monetary amounts therefore arrive as strings on the frontend and must be
 * parsed with the money helpers there (never Number() directly on balances).
 */
@Injectable()
export class BigIntSerializerInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => this.transform(data, 0)));
  }

  private transform(value: unknown, depth: number): unknown {
    if (depth > 8) return value;
    if (typeof value === 'bigint') return value.toString();
    if (value === null || value === undefined) return value;
    if (value instanceof Date) return value;
    if (Array.isArray(value)) return value.map((v) => this.transform(v, depth + 1));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.transform(v, depth + 1);
      }
      return out;
    }
    return value;
  }
}
