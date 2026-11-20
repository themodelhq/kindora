import { decimalsOf } from './money';

/**
 * KINDORA v1.0.8 §7 — EXACT monetary conversion utilities.
 *
 * Financial values must never change because of floating-point conversion.
 * Every function here is implemented with BigInt/string arithmetic only:
 *  - `minorToExactDecimalString`  minor units -> exact major-unit decimal
 *                                 string (provider payload amounts);
 *  - `exactDecimalStringToMinor`  exact major-unit decimal string -> minor
 *                                 units (provider-reported amounts read from
 *                                 the RAW response text);
 *  - `extractJsonNumberToken`     reads a numeric literal out of the RAW JSON
 *                                 body text WITHOUT a float round-trip;
 *  - `assertNumberRoundTrips`     strict safe-range check for any value that
 *                                 MUST pass through a JS Number — rejects
 *                                 values that cannot survive exactly.
 *
 * No function converts through Number before transmission; nothing silently
 * rounds. A value that cannot be represented exactly is REJECTED (fail
 * closed), per v1.0.8 §7.2/§7.3.
 */

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/** Canonical form for exact decimal VALUE comparison (trailing zeros trimmed). */
export function canonicalDecimal(token: string): string {
  if (!DECIMAL_PATTERN.test(token)) {
    throw new Error(`invalid decimal token: ${JSON.stringify(token)}`);
  }
  const [whole, frac] = token.split('.');
  const trimmedWhole = whole.replace(/^0+(?=\d)/, '');
  if (!frac) return trimmedWhole;
  const trimmedFrac = frac.replace(/0+$/, '');
  return trimmedFrac ? `${trimmedWhole}.${trimmedFrac}` : trimmedWhole;
}

/** Exact decimal VALUE equality (never float). */
export function exactDecimalEquals(a: string, b: string): boolean {
  return canonicalDecimal(a) === canonicalDecimal(b);
}

/**
 * Convert integer minor units to the EXACT major-unit decimal string for the
 * currency. Preserves trailing precision (100 -> "1.00", 1050 -> "10.50",
 * XOF 500 -> "500"). Throws on negative, fractional or non-numeric input.
 */
export function minorToExactDecimalString(minor: bigint, currency: string): string {
  if (typeof minor !== 'bigint') {
    throw new Error(`minorToExactDecimalString requires a BigInt minor amount, got ${typeof minor}`);
  }
  if (minor < 0n) {
    throw new Error(`minorToExactDecimalString: negative amounts are invalid (${minor})`);
  }
  const d = decimalsOf(currency);
  const scale = BigInt(10) ** BigInt(d);
  const whole = minor / scale;
  const frac = minor % scale;
  if (d === 0) return whole.toString();
  return `${whole.toString()}.${frac.toString().padStart(d, '0')}`;
}

/**
 * Convert an exact major-unit decimal string (from the provider's RAW
 * response text) into integer minor units. Rejects negative values,
 * exponents, thousands separators, and any precision BEYOND the currency's
 * configured decimals — a 3-decimal amount for a 2-decimal currency is a
 * fail-closed error, never a silent round (v1.0.8 §7.2).
 */
export function exactDecimalStringToMinor(token: string, currency: string): bigint {
  if (!DECIMAL_PATTERN.test(token)) {
    throw new Error(`exactDecimalStringToMinor: invalid amount token ${JSON.stringify(token)}`);
  }
  const d = decimalsOf(currency);
  const [whole, frac = ''] = token.split('.');
  if (frac.length > d) {
    throw new Error(
      `exactDecimalStringToMinor: ${token} carries ${frac.length} decimals but ${currency} has ${d} — refusing to round (fail closed)`,
    );
  }
  const padded = frac.padEnd(d, '0');
  return BigInt(`${whole}${padded}` || '0');
}

/**
 * Extract the LAST occurrence of `"key": <number>` from RAW JSON body text,
 * returning the numeric literal EXACTLY as transmitted (no float parse).
 * Provider bodies can repeat keys (e.g. `amount` inside nested objects);
 * callers cross-check the extracted token against the JSON-parsed value and
 * fail closed on any mismatch.
 */
export function extractJsonNumberToken(bodyText: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'g');
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(bodyText)) !== null) {
    last = match[1];
  }
  return last;
}

/**
 * Strict safe-range validation (v1.0.8 §7.3): a value that MUST pass through
 * a JavaScript Number may only do so when the round-trip is EXACT. Throws on
 * any precision loss — never silently rounds.
 */
export function assertNumberRoundTrips(token: string): void {
  if (!DECIMAL_PATTERN.test(token)) {
    throw new Error(`assertNumberRoundTrips: invalid amount token ${JSON.stringify(token)}`);
  }
  const asNumber = Number(token);
  if (!Number.isFinite(asNumber)) {
    throw new Error(`assertNumberRoundTrips: ${token} is not a finite Number — refusing to transmit`);
  }
  const roundTripped = canonicalDecimal(asNumber.toString());
  if (roundTripped !== canonicalDecimal(token)) {
    throw new Error(
      `assertNumberRoundTrips: ${token} does not survive a Number round-trip (${roundTripped}) — refusing to transmit`,
    );
  }
}

/** Sanity ceiling for any transmitted amount (guard against nonsense values). */
export const MAX_TRANSMITTABLE_MINOR = BigInt('1' + '0'.repeat(18)); // 10^18 minor units

/**
 * Serialize a JSON body where one numeric field is emitted as an EXACT raw
 * decimal token (never a JS Number). Providers that parse JSON numbers into
 * decimals receive the exact transmitted digits — zero float conversion at
 * any magnitude (v1.0.8 §7.3). The token must be a valid decimal literal.
 */
export function jsonStringifyWithRawNumber(payload: Record<string, unknown>, key: string, token: string): string {
  if (!DECIMAL_PATTERN.test(token)) {
    throw new Error(`jsonStringifyWithRawNumber: ${key} token ${JSON.stringify(token)} is not a valid decimal literal`);
  }
  const placeholder = `@@RAW_${key}_${Math.random().toString(36).slice(2, 8)}@@`;
  const json = JSON.stringify({ ...payload, [key]: placeholder });
  const replaced = json.replace(`"${placeholder}"`, token);
  if (replaced === json) {
    throw new Error(`jsonStringifyWithRawNumber: placeholder for ${key} was not substituted`);
  }
  return replaced;
}
