<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>{{ t('members.title') }}</h2>
          <p>{{ t('members.subtitle') }}</p>
        </div>
        <div>
          <el-button :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
          <el-button
            v-if="auth.can('member:write')"
            type="primary"
            @click="openCreate"
          >{{ t('members.addMember') }}</el-button>
        </div>
      </div>
    </template>

    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column :label="t('members.colEmail')" min-width="220" />
      <el-table-column :label="t('members.colRole')" width="160">
        <template #default="{ row }">{{ roleLabel(row.roles) }}</template>
      </el-table-column>
      <el-table-column :label="t('members.colChannel')" width="140">
        <template #default="{ row }">{{ row.channel_name ?? '-' }}</template>
      </el-table-column>
      <el-table-column :label="t('members.colStatus')" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
            {{ row.status === 'active' ? t('members.statusActive') : t('members.statusDisabled') }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('members.colLastLogin')" width="170">
        <template #default="{ row }">{{ fmt(row.last_login_at) }}</template>
      </el-table-column>
      <el-table-column :label="t('common.actions')" width="220">
        <template #default="{ row }">
          <template v-if="auth.can('member:write') && row.id !== auth.user?.id">
            <el-button link type="primary" @click="openRole(row)">{{ t('members.changeRole') }}</el-button>
            <el-button link type="primary" @click="openReset(row)">{{ t('members.resetPassword') }}</el-button>
            <el-button
              link
              :type="row.status === 'active' ? 'danger' : 'primary'"
              @click="toggleStatus(row)"
            >{{ row.status === 'active' ? t('members.disable') : t('members.enable') }}</el-button>
          </template>
          <span v-else class="self">{{ t('members.self') }}</span>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="createOpen" :title="t('members.createTitle')" width="460px">
      <el-form label-width="86px">
        <el-form-item :label="t('members.colEmail')">
          <el-input v-model="form.email" placeholder="teammate@example.com" />
        </el-form-item>
        <el-form-item :label="t('members.initialPassword')">
          <el-input v-model="form.password" type="password" show-password :placeholder="t('members.passwordPlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('members.roleField')">
          <el-select v-model="form.role" style="width: 100%">
            <el-option v-for="r in ROLE_VALUES" :key="r" :label="t(`members.roles.${r}`)" :value="r" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.role === 'developer_partner'" :label="t('members.channelField')">
          <el-select v-model="form.channelId" :placeholder="t('members.channelPlaceholder')" style="width: 100%">
            <el-option v-for="c in channels" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createOpen = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="create">{{ t('common.create') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="resetOpen" :title="t('members.resetTitle')" width="420px">
      <el-form label-width="86px">
        <el-form-item :label="t('members.memberField')">
          <span>{{ current?.email }}</span>
        </el-form-item>
        <el-form-item :label="t('members.newPassword')">
          <el-input v-model="newPassword" type="password" show-password placeholder="至少 8 位" />
        </el-form-item>
      </el-form>
      <p class="tip">{{ t('members.resetTip') }}</p>
      <template #footer>
        <el-button @click="resetOpen = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="resetPassword">{{ t('members.reset') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="roleOpen" :title="t('members.roleTitle')" width="420px">
      <el-form label-width="86px">
        <el-form-item label="成员">
          <span>{{ current?.email }}</span>
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="role" style="width: 100%">
            <el-option v-for="r in ROLE_VALUES" :key="r" :label="t(`members.roles.${r}`)" :value="r" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="roleOpen = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="saveRole">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';
import { useI18n } from 'vue-i18n';

const auth = useAuth();
const { t } = useI18n();

interface Member {
  id: string;
  email: string;
  status: string;
  roles: string[];
  channel_id: string | null;
  channel_name: string | null;
  created_at: string;
  last_login_at: string | null;
}

const ROLE_VALUES = [
  'developer_owner',
  'developer_operator',
  'developer_support',
  'developer_finance',
  'developer_partner',
] as const;

const rows = ref<Member[]>([]);
const loading = ref(false);
const saving = ref(false);
const createOpen = ref(false);
const roleOpen = ref(false);
const current = ref<Member | null>(null);
const role = ref('developer_operator');
const resetOpen = ref(false);
const newPassword = ref('');
const channels = ref<Array<{ id: string; name: string }>>([]);
const form = reactive({ email: '', password: '', role: 'developer_operator', channelId: '' });

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '-';
}

function roleLabel(roles: string[]): string {
  const first = roles[0];
  return first && (ROLE_VALUES as readonly string[]).includes(first)
    ? t(`members.roles.${first}`)
    : (first ?? '-');
}

async function loadChannels(): Promise<void> {
  try {
    const { data } = await api.get('/admin/v1/catalog');
    channels.value = data.data.channels;
  } catch {
    /* 无权限时忽略: 只有渠道角色才需要 */
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.get('/admin/v1/members');
    rows.value = data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  form.email = '';
  form.password = '';
  form.role = 'developer_operator';
  form.channelId = '';
  createOpen.value = true;
}

async function create(): Promise<void> {
  saving.value = true;
  try {
    await api.post('/admin/v1/members', {
      email: form.email,
      password: form.password,
      role: form.role,
      channel_id: form.role === 'developer_partner' ? form.channelId || null : null,
    });
    ElMessage.success(t('members.created'));
    createOpen.value = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

function openRole(row: Member): void {
  current.value = row;
  role.value = row.roles[0] ?? 'developer_operator';
  roleOpen.value = true;
}

async function saveRole(): Promise<void> {
  if (!current.value) return;
  saving.value = true;
  try {
    await api.patch(`/admin/v1/members/${current.value.id}`, { role: role.value });
    ElMessage.success(t('members.roleSaved'));
    roleOpen.value = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

async function toggleStatus(row: Member): Promise<void> {
  const disabling = row.status === 'active';
  try {
    await api.patch(`/admin/v1/members/${row.id}`, {
      status: disabling ? 'disabled' : 'active',
    });
    ElMessage.success(disabling ? t('members.disabled') : t('members.enabled'));
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

function openReset(row: Member): void {
  current.value = row;
  newPassword.value = '';
  resetOpen.value = true;
}

async function resetPassword(): Promise<void> {
  if (!current.value) return;
  if (newPassword.value.length < 8) return ElMessage.error(t('members.pwdTooShort'));
  saving.value = true;
  try {
    await api.post(`/admin/v1/members/${current.value.id}/reset-password`, {
      password: newPassword.value,
    });
    ElMessage.success(t('members.pwdReset'));
    resetOpen.value = false;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void loadChannels();
  void load();
});
</script>

<style scoped>
.self {
  color: #8e8e93;
  font-size: 12px;
}
.tip {
  color: #909399;
  font-size: 12px;
  margin-top: 4px;
}
</style>
