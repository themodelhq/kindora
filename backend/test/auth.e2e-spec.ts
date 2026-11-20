import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { closeTestApp, createTestApp, maybeDescribe } from './setup';

/**
 * Auth flow integration tests (REAL PostgreSQL, mock provider mode):
 *   register -> login -> /auth/me -> refresh (token rotation + reuse detection)
 *   -> cookie-only silent refresh (empty body + kindora_refresh cookie)
 *   -> cross-site Sec-Fetch-Site rejection -> cookie logout (session revoked)
 *   -> wrong password 401 -> throttled forgot-password.
 *
 * register/login responses carry ONLY the access token; the refresh token is
 * delivered as the httpOnly `kindora_refresh` cookie (path /api/v1/auth).
 * TokenDto.refreshToken is @IsOptional() so the cookie is the primary token
 * transport: POST /auth/refresh and /auth/logout accept an EMPTY JSON body
 * when the cookie is present (the browser silent-refresh flow). A body token
 * remains supported for server-to-server callers and is exercised below for
 * rotation/reuse-detection semantics.
 */

const rand = Math.random().toString(36).slice(2, 10);
const creds = {
  email: `auth-e2e-${rand}@kindora.test`,
  password: 'AuthE2ePass1!',
  firstName: 'Ada',
  lastName: 'Obi',
};

function cookieList(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [String(raw)];
}

function refreshTokenFrom(cookies: string[]): string {
  const cookie = cookies.find((c) => c.startsWith('kindora_refresh='));
  return (cookie ?? '').split(';')[0].split('=').slice(1).join('=');
}

/** Login helper returning the access token + the raw kindora_refresh cookie value. */
async function loginAndGetSession(app: NestExpressApplication): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: creds.email, password: creds.password })
    .expect([200, 201]);
  const refreshToken = refreshTokenFrom(cookieList(res));
  expect(refreshToken).toMatch(/^[0-9a-f]{96}$/);
  return { accessToken: res.body.accessToken, refreshToken };
}

maybeDescribe('Auth flow (e2e)', () => {
  let app: NestExpressApplication;
  let accessToken = '';
  let refreshToken = '';

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('registers a new account (201, user payload without password hash)', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send(creds).expect(201);
    expect(res.body.user).toMatchObject({ email: creds.email, role: 'USER' });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('rejects a duplicate registration with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send(creds)
      .expect(400);
  });

  it('logs in and sets the httpOnly kindora_refresh cookie (body has accessToken only)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: creds.email, password: creds.password })
      .expect([200, 201]); // POST default status; the smoke script accepts either

    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.expiresIn).toBeGreaterThan(0);
    expect(res.body.refreshToken).toBeUndefined(); // refresh never travels in the body

    const cookies = cookieList(res);
    const refreshCookie = cookies.find((c) => c.startsWith('kindora_refresh='));
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toContain('HttpOnly');
    expect(refreshCookie).toContain('Path=/api/v1/auth');
    refreshToken = refreshTokenFrom(cookies);
    expect(refreshToken).toMatch(/^[0-9a-f]{96}$/);
    accessToken = res.body.accessToken;
  });

  it('returns the authenticated user via /auth/me with the Bearer token', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.user).toMatchObject({ email: creds.email, role: 'USER' });
  });

  it('rejects /auth/me without a token (401)', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });

  it('refreshes the access token with the token read from the cookie (rotation)', async () => {
    // The refresh token never appears in a response body, so the test replays
    // the value the client would have kept from the Set-Cookie header.
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect([200, 201]);

    expect(res.body.accessToken).toBeTruthy();
    const newRefresh = refreshTokenFrom(cookieList(res));
    expect(newRefresh).toBeTruthy();
    expect(newRefresh).not.toBe(refreshToken); // rotation: old token is revoked
    refreshToken = newRefresh;
    accessToken = res.body.accessToken;
  });

  it('cookie-only silent refresh: EMPTY body + kindora_refresh cookie -> 200 with a rotated cookie', async () => {
    // The browser silent-refresh flow posts with credentials only — no body
    // token. TokenDto.refreshToken is @IsOptional so validation passes and
    // the handler reads the cookie (req.cookies[REFRESH_COOKIE] first).
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `kindora_refresh=${refreshToken}`)
      .send({})
      .expect([200, 201]);

    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.expiresIn).toBeGreaterThan(0);

    const newRefresh = refreshTokenFrom(cookieList(res));
    expect(newRefresh).toBeTruthy();
    expect(newRefresh).not.toBe(refreshToken); // cookie rotated again
    refreshToken = newRefresh;
    accessToken = res.body.accessToken;
  });

  it('rejects refresh without any token (401, handler reached because the DTO is optional)', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({}).expect(401);
    expect(res.body.message).toContain('Missing refresh token');
  });

  it('rejects reuse of the rotated refresh token with 401 (reuse detection revokes the family)', async () => {
    // Re-run the refresh twice from the SAME (already rotated) token is not
    // possible after rotation, so first mint a fresh pair via login.
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: creds.email, password: creds.password })
      .expect([200, 201]);
    const first = refreshTokenFrom(cookieList(login));

    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: first }).expect([200, 201]);

    // Replaying the SAME token: reuse detection -> whole session family revoked.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first })
      .expect(401);
  });

  it('cookie rotation: two consecutive cookie refreshes each rotate, and replaying the first cookie is rejected', async () => {
    const { refreshToken: cookieA1 } = await loginAndGetSession(app);

    const first = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `kindora_refresh=${cookieA1}`)
      .send({})
      .expect([200, 201]);
    const cookieA2 = refreshTokenFrom(cookieList(first));
    expect(cookieA2).toBeTruthy();
    expect(cookieA2).not.toBe(cookieA1); // rotation on every refresh

    const second = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `kindora_refresh=${cookieA2}`)
      .send({})
      .expect([200, 201]);
    const cookieA3 = refreshTokenFrom(cookieList(second));
    expect(cookieA3).toBeTruthy();
    expect(cookieA3).not.toBe(cookieA2);

    // The old cookie value is revoked: replaying it trips reuse detection,
    // which revokes the whole session family for the user.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `kindora_refresh=${cookieA1}`)
      .send({})
      .expect(401);

    // Family revocation also kills the newest cookie of that lineage.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `kindora_refresh=${cookieA3}`)
      .send({})
      .expect(401);
  });

  it('rejects a cross-site refresh (Sec-Fetch-Site: cross-site) with 401 (CSRF defence)', async () => {
    const { refreshToken: cookieB } = await loginAndGetSession(app);

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `kindora_refresh=${cookieB}`)
      .set('Sec-Fetch-Site', 'cross-site')
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.message).toContain('Cross-site request rejected');
  });

  it('cookie logout revokes the session: later refresh with the same cookie is 401', async () => {
    const { refreshToken: cookieC } = await loginAndGetSession(app);

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', `kindora_refresh=${cookieC}`)
      .send({})
      .expect([200, 201])
      .expect({ ok: true });

    const cleared = cookieList(res).find((c) => c.startsWith('kindora_refresh='));
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/kindora_refresh=;/); // value emptied
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);

    // The revoked cookie token can no longer refresh.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `kindora_refresh=${cookieC}`)
      .send({})
      .expect(401);
  });

  it('logout revokes the session and clears the cookie (body-token transport)', async () => {
    // Fresh login: earlier cookie tests trip reuse detection, which revokes
    // whole session families — this test mints its own session so the
    // revocation semantics of logout are exercised on a LIVE token.
    const session = await loginAndGetSession(app);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken: session.refreshToken })
      .expect([200, 201])
      .expect({ ok: true });

    const cleared = cookieList(res).find((c) => c.startsWith('kindora_refresh='));
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/kindora_refresh=;/); // value emptied
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);

    // The revoked token can no longer refresh.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
  });

  it('rejects a wrong password with 401 (and never issues a cookie)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: creds.email, password: 'Definitely-Wrong-1' })
      .expect(401);
    expect(res.body.message).toContain('Invalid email or password');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('forgot-password returns 200 even for unknown emails (enumeration safety)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: `ghost-${rand}@kindora.test` })
      .expect(200)
      .expect({ ok: true });
  });

  it('forgot-password stays OK under the per-route throttle (limit 5/min)', async () => {
    // A few more calls: still below the configured limit of 5/minute.
    for (let i = 0; i < 2; i++) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email: creds.email })
        .expect(200)
        .expect({ ok: true });
    }
  });
});
