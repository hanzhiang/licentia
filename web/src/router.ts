import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./views/Login.vue') },
    {
      path: '/',
      component: () => import('./views/Layout.vue'),
      redirect: '/licenses',
      children: [
        { path: 'licenses', component: () => import('./views/Licenses.vue'), meta: { perm: 'license:read' } },
        { path: 'catalog', component: () => import('./views/Catalog.vue'), meta: { perm: 'product:write' } },
        { path: 'batches', component: () => import('./views/Batches.vue'), meta: { perm: 'license:issue' } },
        { path: 'customers', component: () => import('./views/EndCustomers.vue'), meta: { perm: 'end_customer:write' } },
        { path: 'reports', component: () => import('./views/Reports.vue'), meta: { perm: 'report:read' } },
        { path: 'audit', component: () => import('./views/AuditEvents.vue'), meta: { perm: 'audit:read' } },
        { path: 'apikeys', component: () => import('./views/ApiKeys.vue'), meta: { perm: 'apikey:write' } },
        { path: 'webhooks', component: () => import('./views/Webhooks.vue'), meta: { perm: 'webhook:write' } },
      ],
    },
  ],
});

router.beforeEach((to) => {
  if (to.path !== '/login' && !localStorage.getItem('lp_token')) return '/login';
  if (to.path === '/login' && localStorage.getItem('lp_token')) return '/licenses';
  const perm = to.meta.perm;
  if (typeof perm === 'string') {
    const raw = localStorage.getItem('lp_user');
    const permissions = raw
      ? ((JSON.parse(raw) as { permissions?: string[] }).permissions ?? [])
      : [];
    // 老会话没有 permissions, 先放行并由 Layout 调用 /auth/me 刷新; 后端仍会强制鉴权
    if (permissions.length > 0 && !permissions.includes('*') && !permissions.includes(perm)) {
      return '/licenses';
    }
  }
  return true;
});

export default router;
