<template>
  <el-card>
    <template #header>
      <div class="row">
        <span>渠道/批次统计(激活率、活跃、退款回收)</span>
        <el-button size="small" @click="load">刷新</el-button>
      </div>
    </template>
    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="batch_id" label="批次" width="280" />
      <el-table-column prop="channel_name" label="渠道" width="140" />
      <el-table-column prop="quantity" label="发码量" width="100" />
      <el-table-column prop="activated_count" label="已激活" width="100" />
      <el-table-column prop="active_license_count" label="活跃" width="100" />
      <el-table-column prop="revoked_count" label="吊销(退款)" width="110" />
      <el-table-column label="激活率">
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
