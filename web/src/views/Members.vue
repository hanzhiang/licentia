<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>团队成员</h2>
          <p>自己给自己团队加人、分配角色。平台后台不参与这一步。</p>
        </div>
        <div>
          <el-button :loading="loading" @click="load">刷新</el-button>
          <el-button
            v-if="auth.can('member:write')"
            type="primary"
            @click="openCreate"
          >添加成员</el-button>
        </div>
      </div>
    </template>

    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="email" label="邮箱" min-width="220" />
      <el-table-column label="角色" width="160">
        <template #default="{ row }">{{ roleLabel(row.roles) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
            {{ row.status === 'active' ? '正常' : '已停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="最近登录" width="170">
        <template #default="{ row }">{{ fmt(row.last_login_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="220">
        <template #default="{ row }">
          <template v-if="auth.can('member:write') && row.id !== auth.user?.id">
            <el-button link type="primary" @click="openRole(row)">改角色</el-button>
            <el-button
              link
              :type="row.status === 'active' ? 'danger' : 'primary'"
              @click="toggleStatus(row)"
            >{{ row.status === 'active' ? '停用' : '启用' }}</el-button>
          </template>
          <span v-else class="self">（本人）</span>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="createOpen" title="添加成员" width="460px">
      <el-form label-width="86px">
        <el-form-item label="邮箱">
          <el-input v-model="form.email" placeholder="teammate@example.com" />
        </el-form-item>
        <el-form-item label="初始密码">
          <el-input v-model="form.password" type="password" show-password placeholder="至少 8 位" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width: 100%">
            <el-option v-for="r in ROLE_OPTIONS" :key="r.value" :label="r.label" :value="r.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="create">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="roleOpen" title="修改角色" width="420px">
      <el-form label-width="86px">
        <el-form-item label="成员">
          <span>{{ current?.email }}</span>
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="role" style="width: 100%">
            <el-option v-for="r in ROLE_OPTIONS" :key="r.value" :label="r.label" :value="r.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="roleOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveRole">保存</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';

const auth = useAuth();

interface Member {
  id: string;
  email: string;
  status: string;
  roles: string[];
  created_at: string;
  last_login_at: string | null;
}

const ROLE_OPTIONS = [
  { value: 'developer_owner', label: '开发者(所有者)' },
  { value: 'developer_operator', label: '运营' },
  { value: 'developer_support', label: '客服' },
  { value: 'developer_finance', label: '财务/审计' },
  { value: 'developer_partner', label: '渠道' },
];

const rows = ref<Member[]>([]);
const loading = ref(false);
const saving = ref(false);
const createOpen = ref(false);
const roleOpen = ref(false);
const current = ref<Member | null>(null);
const role = ref('developer_operator');
const form = reactive({ email: '', password: '', role: 'developer_operator' });

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '-';
}

function roleLabel(roles: string[]): string {
  const first = roles[0];
  return ROLE_OPTIONS.find((r) => r.value === first)?.label ?? first ?? '-';
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
  createOpen.value = true;
}

async function create(): Promise<void> {
  saving.value = true;
  try {
    await api.post('/admin/v1/members', {
      email: form.email,
      password: form.password,
      role: form.role,
    });
    ElMessage.success('成员已创建');
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
    ElMessage.success('角色已更新');
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
    ElMessage.success(disabling ? '已停用' : '已启用');
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

onMounted(load);
</script>

<style scoped>
.self {
  color: #8e8e93;
  font-size: 12px;
}
</style>
