<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>{{ t('webhooks.title') }}</h2>
          <p>{{ t('webhooks.subtitle') }}</p>
        </div>
        <div class="actions">
          <el-button :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
          <el-button v-if="auth.can('webhook:write')" type="primary" @click="dialog = true">
            {{ t('webhooks.newEndpoint') }}
          </el-button>
        </div>
      </div>
    </template>
    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="url" :label="t('webhooks.colUrl')" min-width="300" show-overflow-tooltip />
      <el-table-column :label="t('webhooks.colEvents')" min-width="220">
        <template #default="{ row }">{{ row.events.join(', ') }}</template>
      </el-table-column>
      <el-table-column :label="t('webhooks.colStatus')" width="120">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'danger'" size="small">
            {{ row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="failure_count" :label="t('webhooks.colFailureCount')" width="100" />
      <el-table-column :label="t('webhooks.colDisabledUntil')" width="190">
        <template #default="{ row }">
          {{ row.disabled_until ? new Date(row.disabled_until).toLocaleString() : '-' }}
        </template>
      </el-table-column>
      <el-table-column :label="t('common.actions')" width="240">
        <template #default="{ row }">
          <el-button v-if="auth.can('webhook:write')" link type="primary" @click="rotate(row)">{{ t('webhooks.rotateSecret') }}</el-button>
          <el-button v-if="row.status === 'disabled' && auth.can('webhook:write')" link type="success" @click="reset(row)">
            {{ t('webhooks.restore') }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-dialog v-model="dialog" :title="t('webhooks.dialogTitle')" width="560px">
    <el-form label-width="90px">
      <el-form-item :label="t('webhooks.colUrl')">
        <el-input v-model="form.url" placeholder="https://example.com/webhooks/license" />
      </el-form-item>
      <el-form-item :label="t('webhooks.colEvents')">
        <el-select v-model="form.events" multiple filterable style="width: 100%">
          <el-option :label="t('webhooks.allEvents')" value="*" />
          <el-option v-for="e in events" :key="e" :label="e" :value="e" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialog = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="create">{{ t('common.create') }}</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="secretDialog" :title="t('webhooks.secretTitle')" width="620px">
    <el-alert type="warning" :closable="false" :title="t('webhooks.secretNote')" />
    <el-input class="secret" :model-value="secret" readonly type="textarea" :rows="3" />
  </el-dialog>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';
import { useI18n } from 'vue-i18n';

const auth = useAuth();
const { t } = useI18n();

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
    await ElMessageBox.confirm(
      t('webhooks.rotateConfirm'),
      t('webhooks.rotateTitle', { url: row.url }),
      { type: 'warning' },
    );
    const { data } = await api.post(`/admin/v1/webhook-endpoints/${row.id}/rotate-secret`, {});
    secret.value = data.data.secret;
    secretDialog.value = true;
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errMsg(e));
  }
}

async function reset(row: Endpoint): Promise<void> {
  try {
    await ElMessageBox.confirm(t('webhooks.resetConfirm'), t('webhooks.resetTitle', { url: row.url }));
    await api.post(`/admin/v1/webhook-endpoints/${row.id}/reset-breaker`, {});
    ElMessage.success(t('webhooks.restored'));
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
