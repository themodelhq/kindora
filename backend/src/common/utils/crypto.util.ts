import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacHex(algorithm: 'sha256' | 'sha512', secret: string, payload: string | Buffer): string {
  return createHmac(algorithm, secret).update(payload).digest('hex');
}

/** Constant-time comparison of two hex strings. */
export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Random URL-safe token (hex). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** Short public reference with an unambiguous alphabet (no 0/O/1/I). */
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function publicRef(prefix: string, length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  return `${prefix}-${out}`;
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}
