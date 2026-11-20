import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/types/api';

/**
 * The auth store is plain zustand state — drive it directly via
 * setState/getState, no React rendering needed.
 *
 * The bootstrap-ordering tests mock `@/lib/http` (the axios instance cannot
 * run in the node test environment) and pin the documented contract of
 * auth-store.bootstrap():
 *  1. no access token in memory -> POST /auth/refresh FIRST, then /auth/me;
 *  2. refresh failure -> clean unauthenticated state WITHOUT calling /auth/me
 *     (no infinite loop; refresh attempted exactly once per bootstrap);
 *  3. token already in memory -> straight to /auth/me, no refresh call.
 */
const { refreshAccessTokenMock, apiMock, callOrder } = vi.hoisted(() => ({
  refreshAccessTokenMock: vi.fn(),
  apiMock: vi.fn(),
  callOrder: [] as string[],
}));

vi.mock('@/lib/http', () => ({
  api: apiMock,
  refreshAccessToken: refreshAccessTokenMock,
}));

// Imported AFTER the vi.mock above (vitest hoists the mock registration).
import { useAuthStore } from '@/stores/auth-store';

const demoUser: User = {
  id: 'u-test',
  email: 'tester@kindora.org',
  firstName: 'Ada',
  lastName: 'Obi',
  role: 'USER',
  emailVerified: true,
};

describe('auth store', () => {
  beforeEach(() => {
    // Reset to a pristine slice between tests (clear() keeps bootstrapped).
    useAuthStore.setState({ user: null, accessToken: null, bootstrapped: false });
  });

  it('starts signed out: no user, no token, not bootstrapped', () => {
    const { user, accessToken, bootstrapped } = useAuthStore.getState();
    expect(user).toBeNull();
    expect(accessToken).toBeNull();
    expect(bootstrapped).toBe(false);
  });

  it('setUser stores the signed-in user', () => {
    useAuthStore.getState().setUser(demoUser);
    const { user } = useAuthStore.getState();
    expect(user).not.toBeNull();
    expect(user?.id).toBe('u-test');
    expect(user?.email).toBe('tester@kindora.org');

    useAuthStore.getState().setUser(null);
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('setAccessToken stores the in-memory token', () => {
    useAuthStore.getState().setAccessToken('demo-token');
    expect(useAuthStore.getState().accessToken).toBe('demo-token');
  });

  it('clear resets user and access token (session wipe)', () => {
    useAuthStore.setState({ user: demoUser, accessToken: 'demo-token', bootstrapped: true });
    useAuthStore.getState().clear();

    const { user, accessToken } = useAuthStore.getState();
    expect(user).toBeNull();
    expect(accessToken).toBeNull();
  });
});

describe('auth store bootstrap ordering', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, accessToken: null, bootstrapped: false });
    callOrder.length = 0;
    refreshAccessTokenMock.mockReset();
    apiMock.mockReset();
  });

  it('with no token: refreshes FIRST, then calls /auth/me, then stores the user', async () => {
    // Mirror the real refreshAccessToken: on success it stores the fresh
    // access token in the store and returns it.
    refreshAccessTokenMock.mockImplementation(async () => {
      callOrder.push('refresh');
      useAuthStore.getState().setAccessToken('fresh-token');
      return 'fresh-token';
    });
    apiMock.mockImplementation(async () => {
      callOrder.push('me');
      return { user: demoUser };
    });

    await useAuthStore.getState().bootstrap();

    expect(callOrder).toEqual(['refresh', 'me']); // strict ordering
    expect(apiMock).toHaveBeenCalledWith('GET', '/auth/me');
    expect(useAuthStore.getState().accessToken).toBe('fresh-token');
    expect(useAuthStore.getState().user).toMatchObject({ id: 'u-test' });
    expect(useAuthStore.getState().bootstrapped).toBe(true);
  });

  it('with a failed refresh: bootstraps signed out WITHOUT calling /auth/me', async () => {
    // Mirror the real refreshAccessToken failure path: clears auth state,
    // resolves null (never throws).
    refreshAccessTokenMock.mockImplementation(async () => {
      callOrder.push('refresh');
      useAuthStore.getState().clear();
      return null;
    });

    await useAuthStore.getState().bootstrap();

    expect(callOrder).toEqual(['refresh']); // /auth/me must NOT be reached
    expect(apiMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().bootstrapped).toBe(true); // terminates cleanly
  });

  it('with a token already in memory: goes straight to /auth/me (no refresh round-trip)', async () => {
    useAuthStore.getState().setAccessToken('memory-token');
    apiMock.mockImplementation(async () => {
      callOrder.push('me');
      return { user: demoUser };
    });

    await useAuthStore.getState().bootstrap();

    expect(callOrder).toEqual(['me']);
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user).toMatchObject({ id: 'u-test' });
    expect(useAuthStore.getState().bootstrapped).toBe(true);
  });

  it('is idempotent: a second bootstrap call after a completed one is a no-op', async () => {
    apiMock.mockImplementation(async () => {
      callOrder.push('me');
      return { user: demoUser };
    });
    useAuthStore.getState().setAccessToken('memory-token');

    await useAuthStore.getState().bootstrap();
    await useAuthStore.getState().bootstrap(); // bootstrapped already true

    expect(callOrder).toEqual(['me']); // no duplicate calls
  });
});
