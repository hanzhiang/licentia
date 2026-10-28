<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>Webhook 投递</h2>
          <p>HMAC 签名投递，失败自动退避；连续失败会熔断，避免拖垮业务系统。</p>
        </div>
        <div class="actions">
          <el-button :loading="loading" @click="load">刷新</el-button>
          <el-button v-if="auth.can('webhook:write')" type="primary" @click="dialog = true">
            新建端点
          </el-button>
        </div>
      </div>
    </template>
    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="url" label="回调地址" min-width="300" show-overflow-tooltip />
      <el-table-column label="订阅事件" min-width="220">
        <template #default="{ row }">{{ row.events.join(', ') }}</template>
      </el-table-column>
      <el-table-column label="状态" width="120">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'danger'" size="small">
            {{ row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="failure_count" label="熔断次数" width="100" />
      <el-table-column label="自动恢复时间" width="190">
        <template #default="{ row }">
          {{ row.disabled_until ? new Date(row.disabled_until).toLocaleString() : '-' }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="240">
        <template #default="{ row }">
          <el-button v-if="auth.can('webhook:write')" link type="primary" @click="rotate(row)">轮换密钥</el-button>
          <el-button v-if="row.status === 'disabled' && auth.can('webhook:write')" link type="success" @click="reset(row)">
            恢复
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-dialog v-model="dialog" title="新建 Webhook 端点" width="560px">
    <el-form label-width="90px">
      <el-form-item label="回调地址">
        <el-input v-model="form.url" placeholder="https://example.com/webhooks/license" />
      </el-form-item>
      <el-form-item label="订阅事件">
        <el-select v-model="form.events" multiple filterable style="width: 100%">
          <el-option label="全部事件 (*)" value="*" />
          <el-option v-for="e in events" :key="e" :label="e" :value="e" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialog = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="create">创建</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="secretDialog" title="请立即保存签名密钥" width="620px">
    <el-alert type="warning" :closable="false" title="该密钥只显示一次，关闭后无法再次查看。" />
    <el-input class="secret" :model-value="secret" readonly type="textarea" :rows="3" />
  </el-dialog>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';

const auth = useAuth();

interface Endpoint {
  id: string;
  url: string;
  events: string[];
  status: string;
  failure_count: number;
  disabled_until: string | null;
}

const events = [
  'license.activated',
  'license.device_bound',
  'license.device_unbound',
  'license.renewed',
  'license.revoked',
  'license.expired',
  'license.expire_warning',
  'batch.completed',
  'batch.failed',
];

const rows = ref<Endpoint[]>([]);
const loading = ref(false);
const saving = ref(false);
const dialog = ref(false);
const secretDialog = ref(false);
const secret = ref('');
const form = reactive({ url: '', events: ['*'] as string[] });

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.get('/admin/v1/webhook-endpoints');
    rows.value = data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  saving.value = true;
  try {
    const { data } = await api.post('/admin/v1/webhook-endpoints', form);
    secret.value = data.data.secret;
    dialog.value = false;
    secretDialog.value = true;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

async function rotate(row: Endpoint): Promise<void> {
  try {
    await ElMessageBox.confirm('旧密钥会立即失效，确认轮换?', `轮换 ${row.url}`, { type: 'warning' });
    const { data } = await api.post(`/admin/v1/webhook-endpoints/${row.id}/rotate-secret`, {});
    secret.value = data.data.secret;
    secretDialog.value = true;
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errMsg(e));
  }
}

async function reset(row: Endpoint): Promise<void> {
  try {
    await ElMessageBox.confirm('将端点恢复为 active 并从 1 分钟冷却重新计数。', `恢复 ${row.url}`);
    await api.post(`/admin/v1/webhook-endpoints/${row.id}/reset-breaker`, {});
    ElMessage.success('端点已恢复');
    await load();
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errMsg(e));
  }
}

onMounted(load);
</script>

<style scoped>
.page-card { border-radius: 8px; }
.page-head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
.page-head h2 { margin: 0; font-size: 20px; color: #1f2937; }
.page-head p { margin: 6px 0 0; color: #6b7280; font-size: 13px; }
.actions { display: flex; gap: 10px; }
.secret { margin-top: 14px; }
</style>
