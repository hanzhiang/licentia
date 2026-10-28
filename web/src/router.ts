import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./views/Login.vue') },
    { path: '/register', component: () => import('./views/Register.vue') },
    {
      path: '/',
      component: () => import('./views/Layout.vue'),
      children: [
        // 平台层: 只管理开发者账号
        { path: 'developers', component: () => import('./views/Developers.vue'), meta: { perm: 'platform:developer:read' } },
        // 开发者层: 自己的应用、授权码、成员
        { path: 'licenses', component: () => import('./views/Licenses.vue'), meta: { perm: 'license:read' } },
        {
          path: 'catalog',
          component: () => import('./views/Catalog.vue'),
          // 产品/策略/渠道分开授权: 有任意一项写权限就能进这个页面
          meta: { permsAny: ['product:write', 'policy:write', 'channel:write'] },
        },
        { path: 'batches', component: () => import('./views/Batches.vue'), meta: { perm: 'license:issue' } },
        { path: 'customers', component: () => import('./views/EndCustomers.vue'), meta: { perm: 'end_customer:write' } },
        { path: 'members', component: () => import('./views/Members.vue'), meta: { perm: 'member:read' } },
        { path: 'reports', component: () => import('./views/Reports.vue'), meta: { perm: 'report:read' } },
        { path: 'audit', component: () => import('./views/AuditEvents.vue'), meta: { perm: 'audit:read' } },
        { path: 'apikeys', component: () => import('./views/ApiKeys.vue'), meta: { perm: 'apikey:write' } },
        { path: 'webhooks', component: () => import('./views/Webhooks.vue'), meta: { perm: 'webhook:write' } },
      ],
    },
  ],
});

function storedPermissions(): string[] {
  const raw = localStorage.getItem('lp_user');
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as { permissions?: string[] }).permissions ?? [];
  } catch {
    return [];
  }
}

/**
 * 按权限决定落地页:
 * 平台账号进开发者账号管理，开发者按自己的第一个可用能力进入。
 * 这样不同角色登录后看到的首页就是各自职责范围，而不是同一个授权码列表。
 */
export function landingPath(): string {
  const perms = storedPermissions();
  const has = (p: string): boolean => perms.includes('*') || perms.includes(p);
  // 平台账号只看开发者账号
  if (has('platform:developer:read')) return '/developers';
  // 开发者内部按职责分开落地页: 否则四个角色登录后第一屏完全一样
  if (has('member:write')) return '/licenses'; // 所有者: 先看授权全景
  if (has('license:issue')) return '/batches'; // 运营/渠道: 主业是发码
  if (has('report:read')) return '/reports'; // 财务: 报表
  if (has('audit:read')) return '/audit';
  if (has('license:read')) return '/licenses'; // 客服: 查询授权
  return '/login';
}

router.beforeEach((to) => {
  if (to.path !== '/login' && to.path !== '/register' && !localStorage.getItem('lp_token')) {
    return '/login';
  }
  if ((to.path === '/login' || to.path === '/register') && localStorage.getItem('lp_token')) {
    return landingPath();
  }
  if (to.path === '/') return landingPath();

  const permissions = storedPermissions();
  // 老会话没有 permissions, 先放行并由 Layout 调 /auth/me 刷新; 后端仍会强制鉴权
  const known = permissions.length > 0 && !permissions.includes('*');
  const perm = to.meta.perm;
  if (known && typeof perm === 'string' && !permissions.includes(perm)) return landingPath();
  const permsAny = to.meta.permsAny;
  if (known && Array.isArray(permsAny) && !permsAny.some((p) => permissions.includes(p))) {
    return landingPath();
  }
  return true;
});

export default router;
