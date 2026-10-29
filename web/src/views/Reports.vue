<template>
  <el-card>
    <template #header>
      <div class="row">
        <span>{{ t('reports.title') }}</span>
        <el-button size="small" :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
      </div>
    </template>

    <el-tabs v-model="tab">
      <el-tab-pane :label="t('reports.tabOverview')" name="overview">
        <div class="stats">
          <el-statistic :title="t('reports.totalLicenses')" :value="summary.totals.licenses" />
          <el-statistic :title="t('reports.totalActivated')" :value="summary.totals.activated" />
          <el-statistic :title="t('reports.totalRevoked')" :value="summary.totals.revoked" />
          <el-statistic :title="t('reports.totalExpired')" :value="summary.totals.expired" />
          <el-statistic :title="t('reports.expiring30d')" :value="summary.totals.expiring_30d" />
        </div>

        <div class="section-head">
          <h4>{{ t('reports.dailyTitle') }}</h4>
          <el-button link type="primary" @click="exportCsv('/admin/v1/reports/summary.csv?part=daily', 'summary-daily.csv')">
            {{ t('reports.export') }}
          </el-button>
        </div>
        <el-table :data="summary.daily" size="small" max-height="260">
          <el-table-column prop="date" :label="t('reports.colDate')" width="140" />
          <el-table-column prop="issued" :label="t('reports.colIssued')" width="120" />
          <el-table-column prop="activated" :label="t('reports.colActivated')" width="120" />
        </el-table>

        <div class="section-head">
          <h4>{{ t('reports.productTitle') }}</h4>
          <el-button link type="primary" @click="exportCsv('/admin/v1/reports/summary.csv?part=products', 'summary-products.csv')">
            {{ t('reports.export') }}
          </el-button>
        </div>
        <el-table :data="summary.products" size="small">
          <el-table-column prop="name" :label="t('reports.colProduct')" min-width="180" />
          <el-table-column prop="licenses" :label="t('reports.colLicenses')" width="120" />
          <el-table-column prop="activated" :label="t('reports.colActivated')" width="120" />
          <el-table-column prop="revoked" :label="t('reports.colRevoked')" width="140" />
        </el-table>
      </el-tab-pane>

      <el-tab-pane :label="t('reports.tabChannel')" name="channel">
        <div class="section-head">
          <h4>{{ t('reports.title') }}</h4>
          <el-button link type="primary" @click="exportCsv('/admin/v1/reports/channel-stats.csv', 'channel-stats.csv')">
            {{ t('reports.export') }}
          </el-button>
        </div>
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
      </el-tab-pane>
    </el-tabs>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errMsg } from '../api';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

interface Summary {
  totals: {
    licenses: number;
    activated: number;
    revoked: number;
    expired: number;
    expiring_30d: number;
  };
  daily: { date: string; issued: number; activated: number }[];
  products: { id: string; name: string; licenses: number; activated: number; revoked: number }[];
}

const tab = ref('overview');
const rows = ref<Record<string, unknown>[]>([]);
const loading = ref(false);
const summary = reactive<Summary>({
  totals: { licenses: 0, activated: 0, revoked: 0, expired: 0, expiring_30d: 0 },
  daily: [],
  products: [],
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [overview, channels] = await Promise.all([
      api.get('/admin/v1/reports/summary', { params: { days: 30 } }),
      api.get('/admin/v1/reports/channel-stats'),
    ]);
    const d = overview.data.data as Summary & { range_days: number };
    summary.totals = d.totals;
    summary.daily = d.daily;
    summary.products = d.products;
    rows.value = channels.data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

/** 导出走 blob: 直接用 <a href> 带不上 Bearer token */
async function exportCsv(url: string, filename: string): Promise<void> {
  try {
    const res = await api.get(url, { responseType: 'blob' });
    const href = URL.createObjectURL(res.data as Blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(href);
  } catch (e) {
    ElMessage.error(errMsg(e));
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
.stats {
  display: flex;
  gap: 48px;
  margin: 4px 0 18px;
  flex-wrap: wrap;
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 18px 0 8px;
}
.section-head h4 {
  margin: 0;
  font-size: 14px;
  color: #374151;
}
</style>
