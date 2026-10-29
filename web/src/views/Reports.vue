<template>
  <el-card>
    <template #header>
      <div class="row">
        <span>{{ t('reports.title') }}</span>
        <el-button size="small" @click="load">{{ t('common.refresh') }}</el-button>
      </div>
    </template>
    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="batch_id" :label="t('reports.colBatch')" width="280" />
      <el-table-column prop="channel_name" :label="t('reports.colChannel')" width="140" />
      <el-table-column prop="quantity" :label="t('reports.colQuantity')" width="100" />
      <el-table-column prop="activated_count" :label="t('reports.colActivated')" width="100" />
      <el-table-column prop="active_license_count" :label="t('reports.colActive')" width="100" />
      <el-table-column prop="revoked_count" :label="t('reports.colRevoked')" width="110" />
      <el-table-column :label="t('reports.colRate')">
        <template #default="{ row }">
          <el-progress
            :percentage="Number(row.activation_rate_pct)"
            :stroke-width="12"
            :color="Number(row.activation_rate_pct) > 60 ? '#67c23a' : '#e6a23c'"
          />
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

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.get('/admin/v1/reports/channel-stats');
    rows.value = data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
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
