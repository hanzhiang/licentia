export interface SessionUser {
  id: string;
  email: string;
  tenant_id: string | null;
  roles: string[];
  actor_type: string;
  permissions: string[];
}

const TOKEN = 'lp_partner_token';
const REFRESH = 'lp_partner_refresh';
const USER = 'lp_partner_user';

export function getToken(): string {
  return localStorage.getItem(TOKEN) ?? '';
}

export function getUser(): SessionUser | null {
  const raw = localStorage.getItem(USER);
  return raw ? (JSON.parse(raw) as SessionUser) : null;
}

export function saveSession(token: string, refresh: string, user: SessionUser): void {
  localStorage.setItem(TOKEN, token);
  localStorage.setItem(REFRESH, refresh);
  localStorage.setItem(USER, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN);
  localStorage.removeItem(REFRESH);
  localStorage.removeItem(USER);
}
