<template>
  <el-card>
    <template #header>
      <div class="row">
        <span>{{ t('apiKeys.title') }}</span>
        <el-button v-if="auth.can('apikey:write')" type="primary" size="small" @click="dialog = true">
          {{ t('apiKeys.create') }}
        </el-button>
      </div>
    </template>
    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="name" :label="t('apiKeys.colName')" width="180" />
      <el-table-column prop="prefix" :label="t('apiKeys.colPrefix')" width="200" />
      <el-table-column :label="t('apiKeys.colScopes')" width="200">
        <template #default="{ row }">{{ row.scopes.join(', ') }}</template>
      </el-table-column>
      <el-table-column prop="rate_limit_qps" :label="t('apiKeys.colRateLimit')" width="100" />
      <el-table-column prop="status" :label="t('apiKeys.colStatus')" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'active' ? 'success' : 'warning'">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="last_used_at" :label="t('apiKeys.colLastUsed')" width="170">
        <template #default="{ row }">{{ row.last_used_at ? new Date(row.last_used_at).toLocaleString() : '-' }}</template>
      </el-table-column>
      <el-table-column :label="t('common.actions')" width="170">
        <template #default="{ row }">
          <el-button v-if="auth.can('apikey:write')" size="small" link type="primary" @click="rotate(row)">{{ t('apiKeys.rotate') }}</el-button>
          <el-button v-if="auth.can('apikey:write')" size="small" link type="danger" @click="revoke(row)">{{ t('apiKeys.revoke') }}</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="t('apiKeys.dialogTitle')" width="480px">
      <el-form label-width="90px">
        <el-form-item :label="t('apiKeys.colName')">
          <el-input v-model="form.name" :placeholder="t('apiKeys.namePlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('apiKeys.colScopes')">
          <el-checkbox-group v-model="form.scopes">
            <el-checkbox value="validate">{{ t('apiKeys.scopeValidate') }}</el-checkbox>
            <el-checkbox value="license:renew">license:renew</el-checkbox>
            <el-checkbox value="report:read">report:read</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="creating" @click="create">{{ t('common.create') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="keyDialog" :title="t('apiKeys.createdTitle')" width="560px">
      <el-input :model-value="plainKey" readonly type="textarea" :rows="2" />
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errMsg, idemKey } from '../api';
import { useAuth } from '../store';
import { useI18n } from 'vue-i18n';

const auth = useAuth();
const { t } = useI18n();

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: string;
  rate_limit_qps: number;
  last_used_at: string | null;
}

const rows = ref<ApiKeyRow[]>([]);
const loading = ref(false);
const creating = ref(false);
const dialog = ref(false);
const keyDialog = ref(false);
const plainKey = ref('');
const form = reactive({ name: '', scopes: ['validate'] as string[] });

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.get('/admin/v1/api-keys');
    rows.value = data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  creating.value = true;
  try {
    const { data } = await api.post('/admin/v1/api-keys', { name: form.name, scopes: form.scopes });
    plainKey.value = data.data.key;
    dialog.value = false;
    keyDialog.value = true;
    form.name = '';
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    creating.value = false;
  }
}

async function rotate(row: ApiKeyRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      t('apiKeys.rotateConfirm'),
      t('apiKeys.rotateTitle', { name: row.name }),
    );
    const { data } = await api.post(`/admin/v1/api-keys/${row.id}/rotate`, {}, { headers: { 'Idempotency-Key': idemKey() } });
    plainKey.value = data.data.key;
    keyDialog.value = true;
    await load();
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errMsg(e));
  }
}

async function revoke(row: ApiKeyRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      t('apiKeys.revokeConfirm'),
      t('apiKeys.revokeTitle', { name: row.name }),
      { type: 'warning' },
    );
    await api.post(`/admin/v1/api-keys/${row.id}/revoke`, {}, { headers: { 'Idempotency-Key': idemKey() } });
    ElMessage.success(t('apiKeys.revoked'));
    await load();
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errMsg(e));
  }
}

onMounted(load);
</script>

<style scoped>
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
