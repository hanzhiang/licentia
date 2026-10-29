<template>
  <el-card>
    <template #header>
      <div class="row">
        <span>{{ t('audit.title') }}</span>
        <div>
          <el-button size="small" @click="verify" :loading="verifying">{{ t('audit.verify') }}</el-button>
          <el-tag v-if="verifyResult" :type="verifyResult.valid ? 'success' : 'danger'" size="small">
            {{ verifyResult.valid
              ? t('audit.verified', { n: verifyResult.checked })
              : t('audit.broken', { id: verifyResult.brokenAtId }) }}
          </el-tag>
        </div>
      </div>
    </template>
    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="occurred_at" :label="t('audit.colTime')" width="180">
        <template #default="{ row }">{{ new Date(row.occurred_at).toLocaleString() }}</template>
      </el-table-column>
      <el-table-column prop="actor_type" :label="t('audit.colActor')" width="120" />
      <el-table-column prop="action" :label="t('audit.colAction')" width="180" />
      <el-table-column prop="resource_type" :label="t('audit.colResource')" width="140" />
      <el-table-column prop="resource_id" :label="t('audit.colResourceId')" width="280" />
      <el-table-column :label="t('audit.colDetail')">
        <template #default="{ row }">
          <span class="detail">{{ JSON.stringify(row.detail) }}</span>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errMsg } from '../api';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const rows = ref<Record<string, unknown>[]>([]);
const loading = ref(false);
const verifying = ref(false);
const verifyResult = ref<{ valid: boolean; checked: number; brokenAtId?: string } | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.get('/admin/v1/audit-events', { params: { limit: 200 } });
    rows.value = data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function verify(): Promise<void> {
  verifying.value = true;
  try {
    const { data } = await api.get('/admin/v1/audit-events/verify');
    verifyResult.value = data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    verifying.value = false;
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
.detail {
  font-family: monospace;
  font-size: 12px;
  color: #606266;
  word-break: break-all;
}
</style>
