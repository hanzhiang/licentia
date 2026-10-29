<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>{{ t('developers.title') }}</h2>
          <p>{{ t('developers.subtitle') }}</p>
        </div>
        <el-button :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
      </div>
    </template>

    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="name" :label="t('developers.colName')" min-width="180" />
      <el-table-column prop="code" :label="t('developers.colCode')" width="180" />
      <el-table-column :label="t('developers.colStatus')" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'danger'" size="small">
            {{ row.status === 'active' ? t('developers.statusActive') : t('developers.statusSuspended') }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('developers.colMembers')" width="80">
        <template #default="{ row }">{{ row.usage.users }}</template>
      </el-table-column>
      <el-table-column :label="t('developers.colApps')" width="80">
        <template #default="{ row }">{{ row.usage.products }}</template>
      </el-table-column>
      <el-table-column :label="t('developers.colLicenses')" width="130">
        <template #default="{ row }">
          {{ row.usage.licenses_activated }} / {{ row.usage.licenses_total }}
        </template>
      </el-table-column>
      <el-table-column :label="t('developers.colLastActivity')" width="170">
        <template #default="{ row }">{{ fmt(row.usage.last_activity_at) }}</template>
      </el-table-column>
      <el-table-column :label="t('common.actions')" width="120">
        <template #default="{ row }">
          <el-button
            v-if="auth.can('platform:developer:suspend')"
            link
            :type="row.status === 'active' ? 'danger' : 'primary'"
            @click="toggle(row)"
          >
            {{ row.status === 'active' ? t('developers.suspend') : t('developers.resume') }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-empty v-if="!loading && rows.length === 0" :description="t('developers.empty')" />
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';
import { useI18n } from 'vue-i18n';

const auth = useAuth();
const { t } = useI18n();

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
        t('developers.confirmSuspend', { name: row.name }),
        t('developers.confirmSuspendTitle'),
        { type: 'warning' },
      );
    } catch {
      return;
    }
  }
  try {
    await api.post(`/platform/v1/developers/${row.id}/${suspending ? 'suspend' : 'resume'}`);
    ElMessage.success(suspending ? t('developers.suspended') : t('developers.resumed'));
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

onMounted(load);
</script>
