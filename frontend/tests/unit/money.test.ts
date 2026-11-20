import { describe, expect, it } from 'vitest';
import { decimalsOf, formatMoney, majorValue, minorFromMajor, progressPercent } from '@/lib/money';

/**
 * Money helpers work on minor units (kobo/cents) as strings or numbers.
 * Intl output can vary slightly between ICU builds (symbol placement),
 * so assertions check for the significant substrings instead of full equality.
 */
describe('formatMoney', () => {
  it('formats NGN minor units with grouped major value and a currency marker', () => {
    // 2500000 kobo = ₦25,000.00 (minor units are divided by 100 for NGN).
    const formatted = formatMoney('2500000', 'NGN');
    expect(formatted).toContain('25,000.00');
    // Locale/ICU-proof symbol check: full ICU renders the ₦ sign, minimal
    // ICU builds fall back to the ISO code "NGN" — accept either marker.
    expect(formatted).toMatch(/₦|NGN/);
  });

  it('formats USD minor units as dollars', () => {
    const formatted = formatMoney(4100, 'USD');
    expect(formatted).toContain('41.00');
    expect(formatted).toContain('$');
  });

  it('respects zero-decimal currencies like XOF', () => {
    expect(decimalsOf('XOF')).toBe(0);
    const formatted = formatMoney(1500, 'XOF');
    expect(formatted).toContain('1,500');
    // Zero-decimal currencies never render a fractional part.
    expect(formatted).not.toContain('.');
  });

  it('accepts bigint minor units', () => {
    const formatted = formatMoney(BigInt(12345), 'USD');
    expect(formatted).toContain('123.45');
  });

  it('falls back to a plain formatted string for a malformed currency code', () => {
    // Intl throws on a non-3-letter currency code; the helper must degrade
    // gracefully instead of crashing the UI.
    const formatted = formatMoney(1250, 'ZZ');
    expect(formatted).toContain('12.50');
    expect(formatted).toContain('ZZ');
  });
});

describe('decimalsOf', () => {
  it('maps known currencies to their minor-unit scale', () => {
    expect(decimalsOf('NGN')).toBe(2);
    expect(decimalsOf('USD')).toBe(2);
    expect(decimalsOf('GBP')).toBe(2);
    expect(decimalsOf('XOF')).toBe(0);
    expect(decimalsOf('XAF')).toBe(0);
  });

  it('is case-insensitive and defaults unknown currencies to 2', () => {
    expect(decimalsOf('ngn')).toBe(2);
    expect(decimalsOf('xof')).toBe(0);
    expect(decimalsOf('AAA')).toBe(2);
  });
});

describe('majorValue / minorFromMajor roundtrip', () => {
  it('converts minor units to a major-unit number for inputs', () => {
    expect(majorValue(4100, 'USD')).toBe(41);
    expect(majorValue('8345000', 'NGN')).toBe(83450);
    expect(majorValue(7, 'XOF')).toBe(7);
  });

  it('converts a major-unit value back to rounded minor units', () => {
    expect(minorFromMajor(41, 'USD')).toBe(4100);
    expect(minorFromMajor(12.5, 'NGN')).toBe(1250);
    expect(minorFromMajor(7, 'XOF')).toBe(7);
  });

  it('round-trips major -> minor -> major without drift', () => {
    for (const [value, currency] of [
      [19.99, 'NGN'],
      [0.3, 'USD'], // classic float artifact — must still round cleanly
      [1250000, 'NGN'],
      [42, 'XOF'],
    ] as const) {
      const roundtripped = majorValue(minorFromMajor(value, currency), currency);
      expect(roundtripped).toBeCloseTo(value, 6);
    }
  });
});

describe('progressPercent', () => {
  it('computes the rounded percentage of a target', () => {
    expect(progressPercent(2500000, 5000000)).toBe(50);
    expect(progressPercent(1000000, 12000000)).toBe(8); // 8.33 -> 8
    expect(progressPercent(1, 3)).toBe(33);
  });

  it('returns 0 when the target is zero, negative or missing', () => {
    expect(progressPercent(5000000, 0)).toBe(0);
    expect(progressPercent(5000000, -100)).toBe(0);
    expect(progressPercent(0, 0)).toBe(0);
  });

  it('clamps at 100% for over-funded campaigns', () => {
    expect(progressPercent(6125000, 5000000)).toBe(100);
    expect(progressPercent('99999999', '1000')).toBe(100);
  });

  it('accepts string amounts straight from the API', () => {
    expect(progressPercent('8345000', '12000000')).toBe(70);
  });
});
