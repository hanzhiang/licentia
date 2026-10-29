<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>{{ t('notifications.title') }}</h2>
          <p>{{ t('notifications.subtitle') }}</p>
        </div>
        <div class="actions">
          <el-button :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
        </div>
      </div>
    </template>

    <div class="filters">
      <el-radio-group v-model="status" size="small" @change="reload">
        <el-radio-button value="">{{ t('notifications.all') }}</el-radio-button>
        <el-radio-button v-for="s in STATUSES" :key="s" :value="s">
          {{ statusLabel(s) }}<span v-if="counts[s]"> ({{ counts[s] }})</span>
        </el-radio-button>
      </el-radio-group>
    </div>

    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column :label="t('notifications.colTime')" width="170">
        <template #default="{ row }">{{ new Date(row.created_at).toLocaleString() }}</template>
      </el-table-column>
      <el-table-column prop="template_code" :label="t('notifications.colTemplate')" min-width="180" />
      <el-table-column prop="channel" :label="t('notifications.colChannel')" width="90" />
      <el-table-column :label="t('common.status')" width="110">
        <template #default="{ row }">
          <el-tag :type="tagType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="retries" :label="t('notifications.colRetries')" width="80" />
      <el-table-column :label="t('notifications.colSentAt')" width="170">
        <template #default="{ row }">
          {{ row.sent_at ? new Date(row.sent_at).toLocaleString() : '-' }}
        </template>
      </el-table-column>
      <el-table-column :label="t('notifications.colError')" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="err">{{ row.last_error ?? '-' }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('common.actions')" width="110">
        <template #default="{ row }">
          <el-button
            v-if="canRetry(row.status) && auth.can('notify:write')"
            link
            type="primary"
            :loading="retrying === row.id"
            @click="retry(row)"
          >
            {{ t('notifications.retry') }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="pager">
      <el-pagination
        layout="prev, pager, next, total"
        :total="total"
        :page-size="pageSize"
        :current-page="page + 1"
        @current-change="onPage"
      />
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';
import { useI18n } from 'vue-i18n';

const auth = useAuth();
const { t } = useI18n();

interface Row {
  id: string;
  license_id: string | null;
  channel: string;
  template_code: string;
  status: string;
  retries: number;
  last_error: string | null;
  scheduled_for: string;
  next_retry_at: string | null;
  sent_at: string | null;
  created_at: string;
}

const STATUSES = ['pending', 'retrying', 'sent', 'failed', 'dead', 'blocked'] as const;
const pageSize = 50;

const rows = ref<Row[]>([]);
const total = ref(0);
const counts = ref<Record<string, number>>({});
const status = ref('');
const page = ref(0);
const loading = ref(false);
const retrying = ref('');

function statusLabel(s: string): string {
  return t(`notifications.status.${s}`);
}

function tagType(s: string): 'success' | 'warning' | 'danger' | 'info' {
  if (s === 'sent') return 'success';
  if (s === 'pending' || s === 'retrying') return 'warning';
  if (s === 'dead') return 'danger';
  return 'info';
}

function canRetry(s: string): boolean {
  return s === 'failed' || s === 'dead' || s === 'blocked' || s === 'retrying';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.get('/admin/v1/notifications', {
      params: {
        ...(status.value ? { status: status.value } : {}),
        limit: pageSize,
        offset: page.value * pageSize,
      },
    });
    rows.value = data.data.items;
    total.value = data.data.total;
    counts.value = data.data.counts;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

function reload(): void {
  page.value = 0;
  void load();
}

function onPage(p: number): void {
  page.value = p - 1;
  void load();
}

async function retry(row: Row): Promise<void> {
  retrying.value = row.id;
  try {
    await api.post(`/admin/v1/notifications/${row.id}/retry`, {});
    ElMessage.success(t('notifications.queued'));
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    retrying.value = '';
  }
}

onMounted(load);
</script>

<style scoped>
.page-card { border-radius: 8px; }
.page-head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
.page-head h2 { margin: 0; font-size: 20px; color: #1f2937; }
.page-head p { margin: 6px 0 0; color: #6b7280; font-size: 13px; }
.filters { margin-bottom: 12px; }
.pager { margin-top: 12px; display: flex; justify-content: flex-end; }
.err { color: #b91c1c; font-size: 12px; }
</style>
