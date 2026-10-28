import axios from 'axios';
import { clearSession, getToken, saveSession, type SessionUser } from './session';

export const api = axios.create({ baseURL: '/api', timeout: 60000 });

let refreshing: Promise<void> | null = null;

async function refresh(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const token = localStorage.getItem('lp_partner_refresh');
    if (!token) throw new Error('NO_REFRESH_TOKEN');
    const { data } = await axios.post('/api/admin/v1/auth/refresh', { refresh_token: token });
    saveSession(data.data.access_token, data.data.refresh_token, data.data.user as SessionUser);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config as { _retry?: boolean } | undefined;
    if (error.response?.status === 401 && !config?._retry) {
      if (config) config._retry = true;
      try {
        await refresh();
        return await api(error.config);
      } catch {
        clearSession();
        location.reload();
      }
    }
    return Promise.reject(error);
  },
);

export function errMsg(error: unknown): string {
  const e = error as { response?: { data?: { error?: { message?: string } } } };
  return e.response?.data?.error?.message ?? String(error);
}

export function idempotencyKey(): string {
  return crypto.randomUUID();
}
