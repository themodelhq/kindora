import { base32Decode, base32Encode, generateTotpSecret, hotp, totpProvisioningUri, totpVerify } from './totp.util';

/** RFC 4226 Appendix D reference vectors (secret "12345678901234567890"). */
const RFC4226_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC4226_VECTORS: Array<[number, string]> = [
  [0, '755224'],
  [1, '287082'],
  [2, '359152'],
  [3, '969429'],
  [4, '338314'],
  [5, '254676'],
  [6, '287922'],
  [7, '162583'],
  [8, '399871'],
  [9, '520489'],
];

describe('RFC 4226 HOTP conformance', () => {
  it.each(RFC4226_VECTORS)('counter %i produces code %s', (counter, expected) => {
    expect(hotp(RFC4226_SECRET, BigInt(counter))).toBe(expected);
  });
});

describe('base32 (RFC 4648)', () => {
  it('round-trips binary data', () => {
    for (let len = 1; len <= 32; len++) {
      const buf = Buffer.alloc(len);
      for (let i = 0; i < len; i++) buf[i] = (i * 37 + len) & 0xff;
      expect(base32Decode(base32Encode(buf))).toEqual(buf);
    }
  });

  it('matches known vectors', () => {
    expect(base32Encode(Buffer.from('foo'))).toBe('MZXW6===');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI======');
    expect(base32Decode('MZXW6===').toString()).toBe('foo');
  });
});

describe('RFC 6238 TOTP verification', () => {
  /** T=59s with the RFC 4226 secret produces HOTP(1) = 287082 (6-digit truncation of 94287082). */
  const T59 = 59_000;

  it('accepts the RFC 6238 SHA-1 reference code', () => {
    // RFC 6238 Appendix B: T=59, 8-digit code 94287082. The 6-digit profile
    // (Google Authenticator) yields the last 6 digits: 287082 == HOTP(counter=1).
    expect(totpVerify(RFC4226_SECRET, hotp(RFC4226_SECRET, 1n), T59)).toBe(1n);
  });

  it('accepts ±1 step drift and rejects beyond it', () => {
    const now = 1_700_000_000_000;
    const step = BigInt(Math.floor(now / 1000 / 30));
    expect(totpVerify(RFC4226_SECRET, hotp(RFC4226_SECRET, step), now)).toBe(step);
    expect(totpVerify(RFC4226_SECRET, hotp(RFC4226_SECRET, step - 1n), now)).toBe(step - 1n);
    expect(totpVerify(RFC4226_SECRET, hotp(RFC4226_SECRET, step + 1n), now)).toBe(step + 1n);
    expect(totpVerify(RFC4226_SECRET, hotp(RFC4226_SECRET, step - 2n), now)).toBeNull();
    expect(totpVerify(RFC4226_SECRET, hotp(RFC4226_SECRET, step + 2n), now)).toBeNull();
  });

  it('rejects malformed and wrong codes', () => {
    const now = Date.now();
    const step = BigInt(Math.floor(now / 1000 / 30));
    expect(totpVerify(RFC4226_SECRET, 'abc123', now)).toBeNull();
    expect(totpVerify(RFC4226_SECRET, '12345', now)).toBeNull();
    expect(totpVerify(RFC4226_SECRET, '1234567', now)).toBeNull();
    expect(totpVerify(RFC4226_SECRET, '', now)).toBeNull();
    // A wrong-but-well-formed code from a far counter is rejected.
    expect(totpVerify(RFC4226_SECRET, hotp(RFC4226_SECRET, step + 100n), now)).toBeNull();
  });
});

describe('secret generation and provisioning URI', () => {
  it('generates valid base32 secrets of sane entropy', () => {
    const s1 = generateTotpSecret();
    const s2 = generateTotpSecret();
    expect(s1).not.toBe(s2);
    expect(s1).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(s1).length).toBe(20);
  });

  it('builds an otpauth:// URI an authenticator app accepts', () => {
    const uri = totpProvisioningUri('ops@kindora.com', 'KINDORA', 'JBSWY3DPEHPK3PXP');
    expect(uri).toContain('otpauth://totp/KINDORA%3Aops%40kindora.com');
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(uri).toContain('algorithm=SHA1');
  });
});
