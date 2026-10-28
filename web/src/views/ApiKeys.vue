<template>
  <el-card>
    <template #header>
      <div class="row">
        <span>API Key(开放 API, 明文仅创建时可见一次)</span>
        <el-button v-if="auth.can('apikey:write')" type="primary" size="small" @click="dialog = true">
          新建
        </el-button>
      </div>
    </template>
    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="name" label="名称" width="180" />
      <el-table-column prop="prefix" label="前缀" width="200" />
      <el-table-column label="scopes" width="200">
        <template #default="{ row }">{{ row.scopes.join(', ') }}</template>
      </el-table-column>
      <el-table-column prop="rate_limit_qps" label="限流 QPS" width="100" />
      <el-table-column prop="status" label="状态" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'active' ? 'success' : 'warning'">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="last_used_at" label="最近使用" width="170">
        <template #default="{ row }">{{ row.last_used_at ? new Date(row.last_used_at).toLocaleString() : '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="170">
        <template #default="{ row }">
          <el-button v-if="auth.can('apikey:write')" size="small" link type="primary" @click="rotate(row)">轮换</el-button>
          <el-button v-if="auth.can('apikey:write')" size="small" link type="danger" @click="revoke(row)">吊销</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" title="新建 API Key" width="480px">
      <el-form label-width="90px">
        <el-form-item label="名称">
          <el-input v-model="form.name" placeholder="如: 客户业务系统-生产" />
        </el-form-item>
        <el-form-item label="scopes">
          <el-checkbox-group v-model="form.scopes">
            <el-checkbox value="validate">validate(服务端校验)</el-checkbox>
            <el-checkbox value="license:renew">license:renew</el-checkbox>
            <el-checkbox value="report:read">report:read</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="create">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="keyDialog" title="请立即保存 API Key(关闭后不再显示)" width="560px">
      <el-input :model-value="plainKey" readonly type="textarea" :rows="2" />
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errMsg, idemKey } from '../api';
import { useAuth } from '../store';

const auth = useAuth();

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
      '旧 Key 将保留 7 天重叠期后失效, 确认轮换?',
      `轮换 ${row.name}`,
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
    await ElMessageBox.confirm('吊销后立即失效(缓存/网关 1 分钟内全量生效), 确认?', `吊销 ${row.name}`, { type: 'warning' });
    await api.post(`/admin/v1/api-keys/${row.id}/revoke`, {}, { headers: { 'Idempotency-Key': idemKey() } });
    ElMessage.success('已吊销');
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
