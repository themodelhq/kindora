import {
  assertNumberRoundTrips,
  canonicalDecimal,
  exactDecimalEquals,
  exactDecimalStringToMinor,
  extractJsonNumberToken,
  jsonStringifyWithRawNumber,
  minorToExactDecimalString,
} from './exact-money';

/**
 * v1.0.8 §12.5 — exact monetary conversion. No floating-point arithmetic may
 * participate in any financial conversion; every value must survive the
 * round-trip exactly, including values near and beyond the JS safe-integer
 * boundary, zero-decimal and (rejected) over-precision amounts.
 */
describe('exact monetary conversion (v1.0.8 §7/§12.5)', () => {
  describe('minorToExactDecimalString', () => {
    it('produces exact decimal strings for the documented examples', () => {
      expect(minorToExactDecimalString(100n, 'NGN')).toBe('1.00');
      expect(minorToExactDecimalString(105n, 'NGN')).toBe('1.05');
      expect(minorToExactDecimalString(1000n, 'NGN')).toBe('10.00');
      expect(minorToExactDecimalString(1n, 'NGN')).toBe('0.01');
      expect(minorToExactDecimalString(500n, 'XOF')).toBe('500'); // zero-decimal
      expect(minorToExactDecimalString(0n, 'NGN')).toBe('0.00');
    });

    it('preserves trailing precision', () => {
      expect(minorToExactDecimalString(1000n, 'USD')).toBe('10.00');
      expect(minorToExactDecimalString(1_000_000_000n, 'GHS')).toBe('10,000,000.00'.replace(/,/g, ''));
    });

    it('stays exact near and beyond the JS safe-integer boundary', () => {
      // 2^53 = 9007199254740992. Values above it are NOT representable as a
      // Number without loss — the string path remains exact.
      expect(minorToExactDecimalString(9_007_199_254_740_993n, 'NGN')).toBe('90071992547409.93');
      expect(minorToExactDecimalString(10n ** 18n, 'NGN')).toBe('10000000000000000.00');
    });

    it('rejects negative and non-BigInt values', () => {
      expect(() => minorToExactDecimalString(-1n, 'NGN')).toThrow(/negative/);
      expect(() => minorToExactDecimalString(100 as unknown as bigint, 'NGN')).toThrow(/BigInt/);
    });
  });

  describe('exactDecimalStringToMinor', () => {
    it('converts exact tokens to minor units', () => {
      expect(exactDecimalStringToMinor('1.05', 'NGN')).toBe(105n);
      expect(exactDecimalStringToMinor('10', 'NGN')).toBe(1000n);
      expect(exactDecimalStringToMinor('500', 'XOF')).toBe(500n);
      expect(exactDecimalStringToMinor('90071992547409.93', 'NGN')).toBe(9_007_199_254_740_993n);
    });

    it('FAILS CLOSED on more precision than the currency supports', () => {
      expect(() => exactDecimalStringToMinor('1.005', 'NGN')).toThrow(/refusing to round/);
      expect(() => exactDecimalStringToMinor('0.001', 'GHS')).toThrow(/refusing to round/);
    });

    it('rejects malformed, negative and exponent forms', () => {
      expect(() => exactDecimalStringToMinor('-1.00', 'NGN')).toThrow();
      expect(() => exactDecimalStringToMinor('1e3', 'NGN')).toThrow();
      expect(() => exactDecimalStringToMinor('1,000.00', 'NGN')).toThrow();
      expect(() => exactDecimalStringToMinor('abc', 'NGN')).toThrow();
      expect(() => exactDecimalStringToMinor('', 'NGN')).toThrow();
    });
  });

  describe('extractJsonNumberToken', () => {
    it('reads the numeric literal exactly as transmitted', () => {
      const body = `{"status":"success","data":{"id":30400842,"amount":10.5,"currency":"NGN","meta":{"amount":1}}}`;
      expect(extractJsonNumberToken(body, 'amount')).toBe('1'); // LAST occurrence wins; caller cross-checks
      const simple = `{"data":{"amount":90071992547409.93}}`;
      expect(extractJsonNumberToken(simple, 'amount')).toBe('90071992547409.93');
      expect(extractJsonNumberToken('{"amount":105}', 'amount')).toBe('105');
      expect(extractJsonNumberToken('{"amount":"105"}', 'amount')).toBeNull(); // string, not a number literal
    });
  });

  describe('exactDecimalEquals / canonicalDecimal', () => {
    it('compares decimal VALUES exactly', () => {
      expect(exactDecimalEquals('10.00', '10')).toBe(true);
      expect(exactDecimalEquals('0.10', '0.1')).toBe(true);
      expect(exactDecimalEquals('1.05', '1.0500')).toBe(true);
      expect(exactDecimalEquals('1.05', '1.0501')).toBe(false);
      expect(canonicalDecimal('0010.500')).toBe('10.5');
    });
  });

  describe('assertNumberRoundTrips', () => {
    it('accepts values a Number represents exactly', () => {
      expect(() => assertNumberRoundTrips('105')).not.toThrow();
      expect(() => assertNumberRoundTrips('1.05')).not.toThrow();
      expect(() => assertNumberRoundTrips('10')).not.toThrow();
    });

    it('REJECTS values that would lose precision (v1.0.8 §7.3)', () => {
      // > 2^53 integer — Number cannot represent it exactly:
      expect(() => assertNumberRoundTrips('9007199254740993')).toThrow(/round-trip/);
      // Excess decimal precision:
      expect(() => assertNumberRoundTrips('1.0000000000000000001')).toThrow(/round-trip/);
    });
  });

  describe('jsonStringifyWithRawNumber', () => {
    it('emits the EXACT decimal token into the JSON body (no float)', () => {
      const body = jsonStringifyWithRawNumber({ currency: 'NGN', narration: 'payout' }, 'amount', '90071992547409.93');
      const parsed = JSON.parse(body);
      expect(body).toContain('"amount":90071992547409.93');
      expect(parsed.narration).toBe('payout');
      expect(parsed.currency).toBe('NGN');
      // The provider receives the exact transmitted digits.
      expect(body).not.toContain('90071992547409.92'); // the nearest-double corruption
    });

    it('rejects invalid tokens', () => {
      expect(() => jsonStringifyWithRawNumber({}, 'amount', '1e5')).toThrow(/valid decimal/);
      expect(() => jsonStringifyWithRawNumber({}, 'amount', 'x')).toThrow(/valid decimal/);
    });
  });
});
