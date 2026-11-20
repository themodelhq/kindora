import { create } from 'zustand';
import type { User } from '@/types/api';
import { api, refreshAccessToken } from '@/lib/http';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  bootstrapped: boolean;
  setUser: (user: User | null) => void;
  setAccessToken: (token: string) => void;
  clear: () => void;
  bootstrap: () => Promise<void>;
}

/**
 * Access token lives in memory only (XSS-safe; gone on reload).
 * Session continuity comes from the httpOnly refresh cookie on the API
 * domain, rotated by POST /auth/refresh (with reuse detection on the backend).
 *
 * Bootstrap order (restores sessions on reload/restart):
 *  1. If an access token is already in memory, go straight to /auth/me.
 *  2. Otherwise, POST /auth/refresh FIRST (credentials included) — on
 *     success the interceptor has stored a fresh access token and /auth/me
 *     can resolve the profile.
 *  3. If refresh fails, the invalid state is cleared and the app renders
 *     unauthenticated (no infinite loop: refresh is attempted exactly once
 *     per bootstrap).
 */
export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: null,
  bootstrapped: false,
  setUser: (user) => set({ user }),
  setAccessToken: (token) => set({ accessToken: token }),
  clear: () => set({ user: null, accessToken: null }),
  bootstrap: async () => {
    if (get().bootstrapped) return;
    try {
      if (!get().accessToken) {
        // Restore the session from the refresh cookie before anything else.
        await refreshAccessToken();
        if (!useAuthStore.getState().accessToken) {
          // Cookie invalid/expired or refresh rejected — clean unauthenticated state.
          set({ bootstrapped: true, user: null });
          return;
        }
      }
      const res = await api<{ user: User }>('GET', '/auth/me');
      set({ user: res.user, bootstrapped: true });
    } catch {
      set({ bootstrapped: true, user: null });
    }
  },
}));
