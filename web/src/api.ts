import axios from 'axios';

export const api = axios.create({ baseURL: '/api', timeout: 60000 });

interface AuthPayload {
  access_token: string;
  refresh_token: string;
  user: unknown;
}

let refreshing: Promise<AuthPayload> | null = null;

function clearSession(): void {
  localStorage.removeItem('lp_token');
  localStorage.removeItem('lp_refresh');
  localStorage.removeItem('lp_user');
  localStorage.removeItem('lp_tenant');
}

function adoptSession(d: AuthPayload): void {
  localStorage.setItem('lp_token', d.access_token);
  localStorage.setItem('lp_refresh', d.refresh_token);
  localStorage.setItem('lp_user', JSON.stringify(d.user));
  window.dispatchEvent(new CustomEvent('lp-auth-updated', { detail: d.user }));
}

async function refreshSession(): Promise<AuthPayload> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refreshToken = localStorage.getItem('lp_refresh');
    if (!refreshToken) throw new Error('NO_REFRESH_TOKEN');
    const { data } = await axios.post('/api/admin/v1/auth/refresh', {
      refresh_token: refreshToken,
    });
    const payload = data.data as AuthPayload;
    adoptSession(payload);
    return payload;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

api.interceptors.request.use((cfg) => {
  const token = localStorage.getItem('lp_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  const tenantId = localStorage.getItem('lp_tenant');
  if (tenantId) cfg.headers['X-Tenant-Id'] = tenantId;
  return cfg;
});

api.interceptors.response.use(
  (r) => r,
  async (err) => {
    const cfg = err.config as
      | { _retry?: boolean; url?: string; headers?: Record<string, string> }
      | undefined;
    const isAuthEndpoint =
      cfg?.url?.includes('/auth/login') || cfg?.url?.includes('/auth/refresh');
    if (err.response?.status === 401 && !cfg?._retry && !isAuthEndpoint) {
      cfg!._retry = true;
      try {
        const session = await refreshSession();
        cfg!.headers = cfg!.headers ?? {};
        cfg!.headers.Authorization = `Bearer ${session.access_token}`;
        return await api(cfg!);
      } catch {
        clearSession();
        if (!location.pathname.startsWith('/login')) location.href = '/login';
        return Promise.reject(err);
      }
    }
    return Promise.reject(err);
  },
);

export function errMsg(e: unknown): string {
  const ax = e as { response?: { data?: { error?: { message?: string } } } };
  return ax?.response?.data?.error?.message ?? String(e);
}

export function idemKey(): string {
  return crypto.randomUUID();
}
