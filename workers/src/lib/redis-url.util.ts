/**
 * Strict REDIS_URL validation (v1.0.4, P2).
 *
 * v1.0.3 only checked the protocol prefix, so a malformed URL such as
 * `redis://` (no host) or `redis://host:notaport` could pass validation and
 * surface as a confusing connection failure instead of a startup error.
 *
 * This validator uses the standard WHATWG URL parser and enforces:
 *   - syntactically valid URL;
 *   - `redis:` or `rediss:` protocol only (no postgres://, no tcp://, ...);
 *   - non-empty hostname;
 *   - valid port (1-65535) when present;
 *   - valid database path when present (numeric segment: /0, /1, ...);
 *   - credentials (userinfo) are percent-decodable when present;
 *   - no malformed query string (parsed query entries only);
 *   - optional enforced TLS (REDIS_REQUIRE_TLS=true -> `rediss:` required).
 *
 * Security rules:
 *   - Passwords are NEVER included in error messages or logs: the sanitized
 *     form redacts userinfo with `***:***@`.
 *   - Validation results are pure — no connections are made here.
 */

export interface RedisUrlValidation {
  ok: boolean;
  /** Human-readable reason, credential-free. Empty when ok. */
  reason: string;
  /** Redacted URL safe for logs/errors (credentials replaced). */
  sanitized: string;
  /** Whether the URL uses TLS (`rediss:`). */
  tls: boolean;
  /** Numeric database index when a numeric path was provided. */
  db?: number;
}

function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    return u.toString();
  } catch {
    // If even the sanitizer cannot parse it, redact anything after @.
    const at = raw.indexOf('@');
    if (at > 0 && raw.indexOf('//') < at) {
      const schemeEnd = raw.indexOf('://');
      return `${raw.slice(0, Math.max(schemeEnd + 3, 0))}***:***@${raw.slice(at + 1)}`;
    }
    return '<unparsable-redis-url>';
  }
}

export function validateRedisUrl(
  raw: string | undefined | null,
  opts?: { requireTls?: boolean },
): RedisUrlValidation {
  const fail = (reason: string): RedisUrlValidation => ({
    ok: false,
    reason,
    sanitized: raw ? sanitizeUrl(raw) : '<missing-redis-url>',
    tls: false,
  });

  if (!raw || typeof raw !== 'string' || raw.trim() === '') {
    return fail('REDIS_URL is empty');
  }
  const value = raw.trim();

  // Reject obvious malformed shapes the URL parser would otherwise accept
  // as relative or opaque URLs.
  if (!/^(redis|rediss):\/\//i.test(value)) {
    return fail('REDIS_URL must use the redis:// or rediss:// protocol');
  }
  if (/\s/.test(value)) {
    return fail('REDIS_URL must not contain whitespace');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('REDIS_URL is not a valid URL');
  }

  const protocol = url.protocol.toLowerCase().replace(/:$/, '');
  if (protocol !== 'redis' && protocol !== 'rediss') {
    return fail(`Unsupported Redis protocol "${protocol}:" — only redis:// and rediss:// are allowed`);
  }
  const tls = protocol === 'rediss';

  if (opts?.requireTls && !tls) {
    return fail('REDIS_REQUIRE_TLS=true requires a rediss:// (TLS) URL');
  }

  const hostname = url.hostname;
  if (!hostname || hostname.trim() === '') {
    return fail('REDIS_URL is missing the hostname');
  }

  // The WHATWG parser turns "host:notaport" into an invalid URL, but
  // "host:99999" parses with an out-of-range port — validate explicitly.
  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return fail('REDIS_URL has an invalid port (must be 1-65535)');
    }
  }

  // Credentials must be present and decodable; never reflected in errors.
  if (url.username.includes(':')) {
    return fail('REDIS_URL userinfo must be "user:password" with a single separator');
  }
  try {
    if (url.username) decodeURIComponent(url.username);
    if (url.password) decodeURIComponent(url.password);
  } catch {
    return fail('REDIS_URL credentials are not valid percent-encoded text');
  }

  // Path: optional "/<db-number>".
  if (url.pathname && url.pathname !== '/') {
    const dbSegment = url.pathname.replace(/^\//, '');
    if (!/^\d+$/.test(dbSegment)) {
      return fail('REDIS_URL database path must be numeric (e.g. /0)');
    }
  }

  // Query: reject malformed constructs such as "[1]=x" that indicate a typo.
  if (url.search) {
    try {
      const params = new URLSearchParams(url.search);
      for (const [key] of params) {
        if (!key) return fail('REDIS_URL query string contains an empty parameter name');
      }
    } catch {
      return fail('REDIS_URL query string is malformed');
    }
  }

  const dbSegment = url.pathname.replace(/^\//, '');
  const out: RedisUrlValidation = {
    ok: true,
    reason: '',
    sanitized: sanitizeUrl(value),
    tls,
  };
  if (dbSegment) out.db = Number(dbSegment);
  return out;
}
