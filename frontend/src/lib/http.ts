import axios, { AxiosError, type AxiosRequestConfig, type Method } from 'axios';
import { isDemoMode, demoRequest } from '@/lib/demo/adapter';
import { useAuthStore } from '@/stores/auth-store';

export const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:10000';
export const API_PREFIX = '/api/v1';

const http = axios.create({
  baseURL: `${API_BASE_URL}${API_PREFIX}`,
  withCredentials: true, // refresh-token cookie on the API domain
  timeout: 20000,
});

let refreshing: Promise<string | null> | null = null;

/**
 * Single-flight silent refresh: concurrent 401s share ONE refresh request;
 * a failed refresh clears auth state exactly once. Never recurses (uses the
 * bare axios client, not the intercepting instance).
 */
export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshing) {
    refreshing = axios
      .post(`${API_BASE_URL}${API_PREFIX}/auth/refresh`, {}, { withCredentials: true, timeout: 10000 })
      .then((res) => {
        const token = res.data?.accessToken as string | undefined;
        if (token) useAuthStore.getState().setAccessToken(token);
        return token ?? null;
      })
      .catch(() => {
        useAuthStore.getState().clear();
        return null;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

http.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as (AxiosRequestConfig & { _retried?: boolean }) | undefined;
    // Exact-match skip list (never a substring match): only the cookie-consuming
    // auth endpoints are excluded from the refresh-and-retry logic. /auth/me
    // MUST refresh on 401 — that is how sessions restore on page reload.
    const skipRefresh = ['/auth/login', '/auth/refresh', '/auth/logout', '/auth/register'];
    if (
      error.response?.status === 401 &&
      original &&
      !original._retried &&
      !skipRefresh.some((p) => original.url === p)
    ) {
      original._retried = true;
      const token = await refreshAccessToken();
      if (token) {
        original.headers = { ...(original.headers ?? {}), Authorization: `Bearer ${token}` };
        return http.request(original);
      }
    }
    throw error;
  },
);

export class ApiError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

function friendlyError(error: AxiosError): ApiError {
  const status = error.response?.status ?? 0;
  const data = error.response?.data as { message?: string } | undefined;
  const message =
    data?.message ??
    (status === 0 ? 'Cannot reach the KINDORA API. Check your connection.' : error.message || 'Request failed');
  return new ApiError(Array.isArray(message) ? message.join('. ') : message, status, data);
}

/**
 * Central API entry point. In demo mode requests are served by the local
 * adapter; otherwise they go to the KINDORA API on Render.
 */
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (isDemoMode()) {
    try {
      return await demoRequest<T>({ method: method.toUpperCase(), path, body: body as Record<string, unknown> | undefined });
    } catch (err) {
      throw new ApiError(err instanceof Error ? err.message : 'Demo error', 0, err);
    }
  }
  try {
    const config: AxiosRequestConfig = { method, url: path };
    if (body !== undefined) config.data = body;
    const res = await http.request<T>(config);
    return res.data;
  } catch (error) {
    throw friendlyError(error as AxiosError);
  }
}

/**
 * v1.0.4: API entry point with extra headers — used for the single-use fresh
 * MFA challenge token (`x-mfa-challenge`) on payout approval operations.
 * Demo mode rejects MFA-bound operations (no real backend to authorize).
 */
export async function apiWithHeaders<T>(method: Method, path: string, body: unknown, headers: Record<string, string>): Promise<T> {
  if (isDemoMode()) throw new ApiError('This operation requires a live KINDORA API (fresh MFA)', 0);
  try {
    const res = await http.request<T>({ method, url: path, data: body, headers });
    return res.data;
  } catch (error) {
    throw friendlyError(error as AxiosError);
  }
}

export async function apiFormData<T>(path: string, formData: FormData): Promise<T> {
  if (isDemoMode()) throw new ApiError('Uploads are not available in demo mode', 0);
  try {
    const res = await http.post<T>(path, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
    return res.data;
  } catch (error) {
    throw friendlyError(error as AxiosError);
  }
}
