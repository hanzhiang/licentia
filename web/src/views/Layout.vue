<template>
  <el-container class="shell">
    <el-aside width="216px" class="sidebar">
      <div class="brand">
        <span class="brand-mark">LP</span>
        <span>{{ t('app.name') }}</span>
      </div>
      <el-menu router :default-active="$route.path" class="nav">
        <el-menu-item-group v-if="auth.can('platform:developer:read')" :title="t('nav.groupPlatform')">
          <el-menu-item index="/developers">{{ t('nav.developers') }}</el-menu-item>
        </el-menu-item-group>
        <el-menu-item-group v-if="isDeveloper" :title="t('nav.groupApp')">
          <el-menu-item v-if="auth.can('license:read')" index="/licenses">{{ t('nav.licenses') }}</el-menu-item>
          <el-menu-item v-if="canCatalog" index="/catalog">{{ t('nav.catalog') }}</el-menu-item>
          <el-menu-item v-if="auth.can('batch:read')" index="/batches">{{ t('nav.batches') }}</el-menu-item>
          <el-menu-item v-if="auth.can('license:read')" index="/device-requests">{{ t('nav.deviceRequests') }}</el-menu-item>
          <el-menu-item v-if="auth.can('license:read')" index="/customers">{{ t('nav.customers') }}</el-menu-item>
          <el-menu-item v-if="auth.can('member:read')" index="/members">{{ t('nav.members') }}</el-menu-item>
          <el-menu-item v-if="auth.can('report:read')" index="/reports">{{ t('nav.reports') }}</el-menu-item>
        </el-menu-item-group>
        <el-menu-item-group v-if="isDeveloper" :title="t('nav.groupSecurity')">
          <el-menu-item v-if="auth.can('audit:read')" index="/audit">{{ t('nav.audit') }}</el-menu-item>
          <el-menu-item v-if="auth.can('apikey:write')" index="/apikeys">API Key</el-menu-item>
          <el-menu-item v-if="auth.can('webhook:write')" index="/webhooks">{{ t('nav.webhooks') }}</el-menu-item>
        </el-menu-item-group>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <div>
          <strong>{{ auth.user?.email }}</strong>
          <span class="role">{{ roleLabel }}</span>
        </div>
        <div class="header-actions">
          <el-select
            :model-value="locale"
            size="small"
            style="width: 110px"
            @change="changeLocale"
          >
            <el-option label="中文" value="zh-CN" />
            <el-option label="English" value="en" />
          </el-select>
          <el-button link type="danger" @click="logout">{{ t('nav.logout') }}</el-button>
        </div>
      </el-header>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { currentLocale, setLocale, type Locale } from '../i18n';
import { useRouter } from 'vue-router';
import { useAuth } from '../store';
import { api } from '../api';

const auth = useAuth();
const router = useRouter();
const { t } = useI18n();

/** 顶栏角色标签: 认识的 actor_type 给文案, 其余原样显示 */
const ROLE_TYPES = [
  'platform_admin',
  'developer_owner',
  'developer_operator',
  'developer_support',
  'developer_finance',
  'developer_partner',
] as const;
const roleLabel = computed(() => {
  const r = auth.user?.actor_type ?? '';
  return (ROLE_TYPES as readonly string[]).includes(r) ? t(`roles.${r}`) : r;
});
const locale = ref<Locale>(currentLocale());

function changeLocale(value: Locale): void {
  setLocale(value);
  locale.value = value;
}

// 平台账号没有租户上下文, 只看开发者账号; 开发者才看自己的应用与授权
const isDeveloper = computed(
  () => !auth.can('platform:developer:read') && !!auth.user?.tenant_id,
);

// 产品、策略、渠道分开授权, 任一项可写就进同一个配置页
const canCatalog = computed(
  () =>
    auth.can('product:write') || auth.can('policy:write') || auth.can('channel:write'),
);

async function refreshProfile(): Promise<void> {
  try {
    const { data } = await api.get('/admin/v1/auth/me');
    auth.setUser(data.data.user);
  } catch {
    /* 401 由 axios 拦截器统一退出 */
  }
}

function authUpdated(event: Event): void {
  const user = (event as CustomEvent).detail;
  if (user) auth.setUser(user);
}

onMounted(() => {
  window.addEventListener('lp-auth-updated', authUpdated);
  void refreshProfile();
});

onBeforeUnmount(() => {
  window.removeEventListener('lp-auth-updated', authUpdated);
});

async function logout(): Promise<void> {
  try {
    const refresh = localStorage.getItem('lp_refresh');
    if (refresh) await api.post('/admin/v1/auth/logout', { refresh_token: refresh });
  } catch {
    /* 忽略 */
  }
  auth.logout();
  await router.push('/login');
}
</script>

<style scoped>
.brand {
  height: 60px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 18px;
  border-bottom: 1px solid #e7ebee;
  font-weight: 650;
  color: #1f2937;
}
.brand-mark {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 7px;
  background: #167d7f;
  color: #fff;
  font-size: 12px;
  letter-spacing: 0;
}
.shell { height: 100vh; }
.sidebar { background: #fff; border-right: 1px solid #e7ebee; }
.nav { border-right: none; }
.nav :deep(.el-menu-item-group__title) {
  padding: 16px 20px 6px;
  color: #8a939c;
  font-size: 11px;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 60px;
  border-bottom: 1px solid #e7ebee;
  background: #fff;
  color: #606266;
  padding: 0 24px;
}
.role {
  margin-left: 10px;
  padding: 2px 7px;
  border-radius: 4px;
  background: #edf7f7;
  color: #167d7f;
  font-size: 12px;
}
.main { padding: 22px; background: #f5f7f8; }
@media (max-width: 760px) {
  .shell {
    flex-direction: column;
    height: auto;
    min-height: 100vh;
  }
  .sidebar {
    width: 100% !important;
    flex: none;
    border-right: none;
    border-bottom: 1px solid #e7ebee;
  }
  .brand {
    height: 52px;
  }
  .nav {
    display: flex;
    overflow-x: auto;
    white-space: nowrap;
  }
  .nav :deep(.el-menu-item-group),
  .nav :deep(.el-menu-item-group > ul) {
    display: flex;
    flex: none;
  }
  .nav :deep(.el-menu-item-group__title) {
    display: none;
  }
  .nav :deep(.el-menu-item) {
    height: 44px;
    line-height: 44px;
    padding: 0 12px !important;
    flex: none;
  }
  .header {
    height: 54px;
    padding: 0 14px;
    flex: none;
  }
  .main {
    padding: 12px !important;
  }
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>
