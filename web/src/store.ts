import { defineStore } from 'pinia';

export interface UserInfo {
  id: string;
  email: string;
  tenant_id: string | null;
  roles: string[];
  actor_type: string;
  permissions: string[];
}

function storedUser(): UserInfo | null {
  const raw = localStorage.getItem('lp_user');
  if (!raw) return null;
  const user = JSON.parse(raw) as Partial<UserInfo>;
  return {
    ...(user as UserInfo),
    permissions: Array.isArray(user.permissions) ? user.permissions : [],
  };
}

export const useAuth = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('lp_token') ?? '',
    tenantId: localStorage.getItem('lp_tenant') ?? '',
    user: storedUser(),
  }),
  getters: {
    can: (state) => (permission: string): boolean => {
      const permissions = state.user?.permissions ?? [];
      return permissions.includes('*') || permissions.includes(permission);
    },
  },
  actions: {
    setLogin(token: string, refreshToken: string, user: UserInfo): void {
      this.token = token;
      this.user = user;
      // 普通租户身份来自 JWT; 只有平台超管才通过 X-Tenant-Id 选择目标租户
      this.tenantId = '';
      localStorage.setItem('lp_token', token);
      localStorage.setItem('lp_refresh', refreshToken);
      localStorage.setItem('lp_user', JSON.stringify(user));
      localStorage.removeItem('lp_tenant');
    },
    setUser(user: UserInfo): void {
      this.user = user;
      localStorage.setItem('lp_user', JSON.stringify(user));
    },
    setTenant(tenantId: string): void {
      this.tenantId = tenantId.trim();
      if (this.tenantId) localStorage.setItem('lp_tenant', this.tenantId);
      else localStorage.removeItem('lp_tenant');
    },
    logout(): void {
      this.token = '';
      this.user = null;
      localStorage.removeItem('lp_token');
      localStorage.removeItem('lp_refresh');
      localStorage.removeItem('lp_user');
      localStorage.removeItem('lp_tenant');
    },
  },
});
