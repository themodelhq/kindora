import { createHmac, randomBytes } from 'node:crypto';

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30-second step) with RFC 4648 Base32
 * secrets — the profile implemented by Google Authenticator, Authy, 1Password
 * and Microsoft Authenticator. Implemented locally (no new runtime dependency)
 * so the payout approval step-up has no supply-chain surface beyond Node core.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept one step back/forward to tolerate clock drift. */
export const TOTP_WINDOW = 1;

export function base32Encode(buf: Buffer): string {
  let value = 0n;
  let bits = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8n) | BigInt(byte);
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[Number((value >> BigInt(bits - 5)) & 31n)];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[Number((value << BigInt(5 - bits)) & 31n)];
  }
  // RFC 4648 padding: the output length must be a multiple of 8.
  return output + '='.repeat((8 - (output.length % 8)) % 8);
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0n;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5n) | BigInt(idx);
    bits += 5;
    if (bits >= 8) {
      bytes.push(Number((value >> BigInt(bits - 8)) & 255n));
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP (HMAC-SHA1, dynamic truncation, 6 decimal digits). */
export function hotp(secret: Buffer, counter: bigint): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Verify a TOTP at the current time with ±window tolerance.
 * Returns the matched counter on success (for replay suppression) or null.
 */
export function totpVerify(secret: Buffer, code: string, nowMs = Date.now(), window = TOTP_WINDOW): bigint | null {
  if (!/^\d{6}$/.test(code)) return null;
  const counter = BigInt(Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
  const provided = Buffer.from(code);
  for (let drift = -window; drift <= window; drift++) {
    const c = counter + BigInt(drift);
    if (c < 0n) continue;
    const expected = Buffer.from(hotp(secret, c));
    // Constant-time comparison over fixed-width buffers.
    if (expected.length === provided.length && timingSafeEqualBuffer(expected, provided)) {
      return c;
    }
  }
  return null;
}

function timingSafeEqualBuffer(a: Buffer, b: Buffer): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** otpauth:// provisioning URI for authenticator apps. */
export function totpProvisioningUri(label: string, issuer: string, secret: string): string {
  return (
    `otpauth://totp/${encodeURIComponent(`${issuer}:${label}`)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`
  );
}
