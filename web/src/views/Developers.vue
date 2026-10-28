<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>开发者账号</h2>
          <p>平台只管理账号本身与用量汇总，不介入各开发者内部的授权码、用户与设备。</p>
        </div>
        <el-button :loading="loading" @click="load">刷新</el-button>
      </div>
    </template>

    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="name" label="开发者" min-width="180" />
      <el-table-column prop="code" label="租户码" width="180" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'danger'" size="small">
            {{ row.status === 'active' ? '正常' : '已停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="成员" width="80">
        <template #default="{ row }">{{ row.usage.users }}</template>
      </el-table-column>
      <el-table-column label="应用" width="80">
        <template #default="{ row }">{{ row.usage.products }}</template>
      </el-table-column>
      <el-table-column label="授权码" width="130">
        <template #default="{ row }">
          {{ row.usage.licenses_activated }} / {{ row.usage.licenses_total }}
        </template>
      </el-table-column>
      <el-table-column label="最近活动" width="170">
        <template #default="{ row }">{{ fmt(row.usage.last_activity_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button
            v-if="auth.can('platform:developer:suspend')"
            link
            :type="row.status === 'active' ? 'danger' : 'primary'"
            @click="toggle(row)"
          >
            {{ row.status === 'active' ? '停用' : '恢复' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-empty v-if="!loading && rows.length === 0" description="还没有开发者注册" />
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';

const auth = useAuth();

interface Developer {
  id: string;
  code: string;
  name: string;
  status: string;
  plan: string;
  created_at: string;
  usage: {
    users: number;
    products: number;
    licenses_total: number;
    licenses_activated: number;
    last_activity_at: string | null;
  };
}

const rows = ref<Developer[]>([]);
const loading = ref(false);

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '-';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.get('/platform/v1/developers');
    rows.value = data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function toggle(row: Developer): Promise<void> {
  const suspending = row.status === 'active';
  if (suspending) {
    try {
      await ElMessageBox.confirm(
        `停用后「${row.name}」下所有成员将无法登录，其客户端心跳也会被拒绝。确认停用？`,
        '停用开发者账号',
        { type: 'warning' },
      );
    } catch {
      return;
    }
  }
  try {
    await api.post(`/platform/v1/developers/${row.id}/${suspending ? 'suspend' : 'resume'}`);
    ElMessage.success(suspending ? '已停用' : '已恢复');
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

onMounted(load);
</script>
