import { validateRedisUrl } from './redis-url.util';

describe('validateRedisUrl (v1.0.4 §9)', () => {
  const base = { requireTls: false };

  it.each([
    ['redis://localhost:6379', 'valid redis URL'],
    ['rediss://user:pass@kindora-redis.render.com:6379/0', 'valid rediss URL with credentials and db path'],
    ['redis://host', 'valid URL without port'],
  ])('accepts %s (%s)', (url) => {
    const res = validateRedisUrl(url, base);
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('');
  });

  it('marks tls=true for rediss and false for redis', () => {
    expect(validateRedisUrl('rediss://host').tls).toBe(true);
    expect(validateRedisUrl('redis://host').tls).toBe(false);
  });

  it('parses the numeric database path', () => {
    const res = validateRedisUrl('redis://host:6379/3');
    expect(res.ok).toBe(true);
    expect(res.db).toBe(3);
  });

  it.each([
    ['', 'missing URL'],
    [undefined, 'missing URL'],
    ['   ', 'missing URL'],
    ['postgres://host/db', 'unsupported protocol'],
    ['tcp://host:6379', 'unsupported protocol'],
    ['redis://', 'missing hostname'],
    ['redis://:6379', 'missing hostname'],
    ['redis://host:notaport', 'invalid port'],
    ['redis://host:99999', 'invalid port'],
    ['redis://host:0', 'invalid port'],
    ['redis://host/abc', 'non-numeric db path'],
    ['redis://host:6379/', 'valid URL'], // empty path is fine
    ['red is://host', 'whitespace'],
    ['redis://user:p%2word@host', 'bad percent-encoding in credentials'],
  ])('%s -> handled (%s)', (url, label) => {
    const res = validateRedisUrl(url as string, base);
    if (label === 'valid URL') {
      expect(res.ok).toBe(true);
    } else {
      expect(res.ok).toBe(false);
      expect(res.reason).toBeTruthy();
    }
  });

  it('never leaks credentials in error output', () => {
    const secret = 'super-secret-password-42';
    const res = validateRedisUrl(`redis://default:${secret}@host:6379/0`);
    expect(JSON.stringify(res)).not.toContain(secret);
    expect(res.sanitized).toContain('***');
  });

  it('enforces TLS when REDIS_REQUIRE_TLS=true', () => {
    expect(validateRedisUrl('redis://host', { requireTls: true }).ok).toBe(false);
    expect(validateRedisUrl('rediss://host', { requireTls: true }).ok).toBe(true);
  });

  it('rejects empty query parameter names', () => {
    expect(validateRedisUrl('redis://host?=x').ok).toBe(false);
    expect(validateRedisUrl('redis://host?family=6').ok).toBe(true);
  });
});
