import { decimalsOf, formatMoney, percentOf, sumMinor, toMinor } from './money';

/**
 * Unit tests for the money helpers (no database, no Nest providers).
 * All balances are BigInt minor units; floating point is only ever used for
 * display, so conversions must be exact and free of float artifacts.
 */
describe('money utils', () => {
  describe('toMinor', () => {
    it('converts 19.99 USD to 1999n without float artifacts', () => {
      // 19.99 * 100 === 1998.9999999999998 in IEEE-754: the string-based
      // implementation must still yield exactly 1999.
      expect(toMinor(19.99, 'USD')).toBe(1999n);
    });

    it('handles the 0.1 + 0.2 style cases', () => {
      expect(toMinor(0.1 + 0.2, 'USD')).toBe(30n); // 0.30000000000000004 -> 0.30 -> 30c
      expect(toMinor(1.1 + 2.2, 'USD')).toBe(330n); // 3.3000000000000003 -> 3.30
      expect(toMinor(45.3 - 5.3, 'USD')).toBe(4000n); // 39.99999999999999 -> 40.00
    });

    it('accepts string input and keeps integer amounts exact', () => {
      expect(toMinor('2500000', 'NGN')).toBe(250000000n);
      expect(toMinor('19.99', 'USD')).toBe(1999n);
      expect(toMinor(1000000, 'NGN')).toBe(100000000n);
    });

    it('round-trips major -> minor for typical donation amounts', () => {
      expect(toMinor(25000, 'NGN')).toBe(2500000n);
      expect(toMinor(0.01, 'USD')).toBe(1n);
    });

    it('treats zero-decimal currencies (XOF) as major == minor', () => {
      expect(toMinor(1500, 'XOF')).toBe(1500n);
      expect(toMinor('2500', 'XAF')).toBe(2500n);
    });

    it('rejects non-finite input', () => {
      expect(() => toMinor(Number.NaN, 'USD')).toThrow(/Invalid amount/);
      expect(() => toMinor(Number.POSITIVE_INFINITY, 'USD')).toThrow(/Invalid amount/);
      expect(() => toMinor('not-a-number', 'USD')).toThrow(/Invalid amount/);
    });
  });

  describe('decimalsOf', () => {
    it('maps known currencies', () => {
      expect(decimalsOf('USD')).toBe(2);
      expect(decimalsOf('NGN')).toBe(2);
      expect(decimalsOf('XOF')).toBe(0);
      expect(decimalsOf('XAF')).toBe(0);
    });

    it('is case-insensitive', () => {
      expect(decimalsOf('xof')).toBe(0);
      expect(decimalsOf('usd')).toBe(2);
    });

    it('falls back to 2 decimals for unknown currencies', () => {
      expect(decimalsOf('XYZ')).toBe(2);
    });
  });

  describe('formatMoney', () => {
    it('formats USD with two decimals and the $ symbol', () => {
      expect(formatMoney(1999n, 'USD')).toBe('$19.99');
    });

    it('formats NGN with grouping (symbol spelling varies by ICU build)', () => {
      const formatted = formatMoney(250000n, 'NGN'); // 2,500.00 NGN
      expect(formatted).toMatch(/2,500\.00/);
      expect(formatted).toMatch(/NGN|₦/);
    });

    it('formats zero-decimal XOF without fractional digits', () => {
      const formatted = formatMoney(1500n, 'XOF');
      expect(formatted).toContain('1,500');
      expect(formatted).not.toMatch(/\.\d{2}$/); // no cents appended
    });

    it('accepts string minor amounts', () => {
      expect(formatMoney('1999', 'USD')).toBe('$19.99');
    });

    it('falls back to a plain label for unknown currencies', () => {
      const formatted = formatMoney(1234n, 'ZZZ'); // Intl may separate with a narrow NBSP
      expect(formatted).toContain('12.34');
      expect(formatted.startsWith('ZZZ')).toBe(true);
    });
  });

  describe('percentOf', () => {
    it('computes whole percentages', () => {
      expect(percentOf(10000n, 15)).toBe(1500n);
      expect(percentOf(2500000n, 5)).toBe(125000n);
      expect(percentOf(1000000n, 100)).toBe(1000000n);
    });

    it('supports fractional percentages', () => {
      expect(percentOf(10000n, 12.5)).toBe(1250n);
    });

    it('floors sub-unit remainders (no fractional minor units)', () => {
      expect(percentOf(999n, 10)).toBe(99n); // 99.9 -> 99
    });

    it('returns 0n for non-positive percentages', () => {
      expect(percentOf(10000n, 0)).toBe(0n);
      expect(percentOf(10000n, -5)).toBe(0n);
    });
  });

  describe('sumMinor', () => {
    it('sums bigint and string minor values', () => {
      expect(sumMinor([1000n, '2500000', 125000n])).toBe(2626000n);
    });

    it('returns 0n for an empty list', () => {
      expect(sumMinor([])).toBe(0n);
    });

    it('keeps precision far beyond Number.MAX_SAFE_INTEGER', () => {
      expect(sumMinor([9007199254740993n, 1n])).toBe(9007199254740994n);
    });
  });
});
