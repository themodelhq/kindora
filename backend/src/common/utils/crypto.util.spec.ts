import { createHmac, createHash } from 'node:crypto';
import { hmacHex, publicRef, randomToken, safeEqualHex, sha256Hex } from './crypto.util';

/** Unambiguous reference alphabet: no 0/O/1/I. */
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

describe('crypto utils', () => {
  describe('publicRef', () => {
    it('produces "<prefix>-<8 chars>" from the unambiguous alphabet', () => {
      const ref = publicRef('KDO');
      expect(ref).toMatch(new RegExp(`^KDO-[${REF_ALPHABET}]{8}$`));
    });

    it('never emits ambiguous characters (0/O/1/I) across many draws', () => {
      for (let i = 0; i < 500; i++) {
        const ref = publicRef('KDO');
        const randomPart = ref.slice('KDO-'.length);
        expect(randomPart).toHaveLength(8);
        expect(randomPart).not.toMatch(/[01OI]/);
        for (const ch of randomPart) {
          expect(REF_ALPHABET).toContain(ch);
        }
      }
    });

    it('honours a custom length', () => {
      expect(publicRef('WDR', 12)).toMatch(new RegExp(`^WDR-[${REF_ALPHABET}]{12}$`));
    });

    it('generates unique refs across draws (overwhelming probability)', () => {
      const refs = new Set(Array.from({ length: 200 }, () => publicRef('KDO')));
      expect(refs.size).toBe(200);
    });
  });

  describe('randomToken', () => {
    it('defaults to 32 bytes encoded as 64 hex characters', () => {
      const token = randomToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('honours a custom byte length', () => {
      expect(randomToken(16)).toMatch(/^[0-9a-f]{32}$/);
      expect(randomToken(24)).toHaveLength(48);
    });

    it('produces distinct tokens', () => {
      const tokens = new Set(Array.from({ length: 50 }, () => randomToken(8)));
      expect(tokens.size).toBe(50);
    });
  });

  describe('hmacHex', () => {
    it('matches the HMAC-SHA512 known vector computed via node crypto', () => {
      // Compute the expected value once with the platform crypto primitive
      // (RFC 4231-style cross-check of our thin wrapper).
      const expected = createHmac('sha512', 'key').update('test').digest('hex');
      expect(hmacHex('sha512', 'key', 'test')).toBe(expected);
    });

    it('matches HMAC-SHA256 over a Buffer payload', () => {
      const payload = Buffer.from('charge.success');
      const expected = createHmac('sha256', 'sk_test_kindora').update(payload).digest('hex');
      expect(hmacHex('sha256', 'sk_test_kindora', payload)).toBe(expected);
    });

    it('is deterministic and key/payload sensitive', () => {
      expect(hmacHex('sha512', 'key', 'test')).toBe(hmacHex('sha512', 'key', 'test'));
      expect(hmacHex('sha512', 'key', 'test')).not.toBe(hmacHex('sha512', 'key2', 'test'));
      expect(hmacHex('sha512', 'key', 'test')).not.toBe(hmacHex('sha512', 'key', 'test2'));
    });

    it('returns 128 hex characters for sha512 and 64 for sha256', () => {
      expect(hmacHex('sha512', 'k', 'v')).toMatch(/^[0-9a-f]{128}$/);
      expect(hmacHex('sha256', 'k', 'v')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('safeEqualHex', () => {
    it('returns true for identical digests', () => {
      const a = sha256Hex('payload');
      expect(safeEqualHex(a, a)).toBe(true);
      expect(safeEqualHex(a, sha256Hex('payload'))).toBe(true);
    });

    it('returns false for different digests of equal length', () => {
      const a = sha256Hex('payload-a');
      const b = sha256Hex('payload-b');
      expect(safeEqualHex(a, b)).toBe(false);
    });

    it('returns false on length mismatch (no throw from timingSafeEqual)', () => {
      const a = sha256Hex('payload'); // 64 chars
      expect(safeEqualHex(a, a.slice(0, 32))).toBe(false);
      expect(safeEqualHex('', a)).toBe(false);
    });

    it('handles empty strings of equal length', () => {
      expect(safeEqualHex('', '')).toBe(true);
    });
  });

  describe('sha256Hex', () => {
    it('matches node crypto for a known input', () => {
      expect(sha256Hex('test')).toBe(createHash('sha256').update('test').digest('hex'));
    });
  });
});
