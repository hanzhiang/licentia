<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>{{ t('licenses.title') }}</h2>
          <p>{{ t('licenses.subtitle') }}</p>
        </div>
        <div class="filters">
          <el-select v-model="status" :placeholder="t('licenses.filterPlaceholder')" clearable style="width: 150px" @change="load">
            <el-option v-for="s in statuses" :key="s" :label="statusLabel(s)" :value="s" />
          </el-select>
          <el-button :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
        </div>
      </div>
    </template>

    <el-table :data="rows" v-loading="loading" size="small" @row-click="openDetail">
      <el-table-column prop="code_masked" :label="t('licenses.colCode')" min-width="250" />
      <el-table-column prop="kind" :label="t('licenses.colKind')" width="110" />
      <el-table-column prop="status" :label="t('licenses.colStatus')" width="120">
        <template #default="{ row }">
          <el-tag :type="tagType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('licenses.colDevices')" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.active_devices === 0 ? 'info' : 'success'">
            {{ row.active_devices ?? 0 }} / {{ row.device_limit ?? '-' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('licenses.colActivatedAt')" width="180">
        <template #default="{ row }">{{ fmt(row.activated_at) }}</template>
      </el-table-column>
      <el-table-column :label="t('licenses.colExpiresAt')" width="180">
        <template #default="{ row }">{{ fmt(row.expires_at) }}</template>
      </el-table-column>
      <el-table-column :label="t('common.actions')" width="220">
        <template #default="{ row }">
          <el-button size="small" type="primary" link @click.stop="openDetail(row)">{{ t('licenses.open') }}</el-button>
          <el-button
            v-if="auth.can('license:renew')"
            size="small"
            type="primary"
            link
            :disabled="row.status === 'revoked' || row.status === 'issued'"
            @click.stop="renew(row)"
          >
            {{ t('licenses.renew') }}
          </el-button>
          <el-button
            v-if="auth.can('license:revoke:approve')"
            size="small"
            type="danger"
            link
            :disabled="row.status === 'revoked'"
            @click.stop="revoke(row)"
          >
            {{ t('licenses.revoke') }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-drawer v-model="drawer" size="680px" :title="detail?.code_masked ?? t('licenses.drawerTitle')">
    <div v-loading="detailLoading">
      <el-descriptions v-if="detail" :column="2" border size="small">
        <el-descriptions-item :label="t('licenses.fieldStatus')">{{ statusLabel(detail.status) }}</el-descriptions-item>
        <el-descriptions-item :label="t('licenses.fieldKind')">{{ detail.kind }}</el-descriptions-item>
        <el-descriptions-item :label="t('licenses.fieldDeviceLimit')">{{ detail.device_limit }}</el-descriptions-item>
        <el-descriptions-item :label="t('licenses.fieldSeatLimit')">{{ detail.seat_limit ?? t('common.none') }}</el-descriptions-item>
        <el-descriptions-item :label="t('licenses.colActivatedAt')">{{ fmt(detail.activated_at) }}</el-descriptions-item>
        <el-descriptions-item :label="t('licenses.colExpiresAt')">{{ fmt(detail.expires_at) }}</el-descriptions-item>
        <el-descriptions-item :label="t('licenses.fieldFeatures')" :span="2">
          {{ detail.features?.join(', ') || '-' }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('licenses.fieldLicenseId')" :span="2">{{ detail.id }}</el-descriptions-item>
      </el-descriptions>

      <div class="drawer-actions" v-if="auth.can('license:issue') && detail">
        <el-button size="small" type="primary" @click="deliver">{{ t('licenses.deliver') }}</el-button>
        <span class="hint">{{ t('licenses.deliverHint') }}</span>
      </div>

      <div class="section-title">{{ t('licenses.currentDevices') }}</div>
      <el-table :data="activations" size="small" :empty-text="t('licenses.emptyActivations')">
        <el-table-column :label="t('licenses.colDevice')" min-width="170">
          <template #default="{ row }">
            {{ row.device?.display_name || row.device?.id || t('licenses.orgSeat') }}
          </template>
        </el-table-column>
        <el-table-column :label="t('licenses.colPlatform')" width="110">
          <template #default="{ row }">{{ row.device?.platform || '-' }}</template>
        </el-table-column>
        <el-table-column :label="t('licenses.colLastSeen')" width="170">
          <template #default="{ row }">{{ fmt(row.last_seen_at) }}</template>
        </el-table-column>
        <el-table-column :label="t('common.actions')" width="100">
          <template #default="{ row }">
            <el-button type="danger" link size="small" @click="release(row)">{{ t('licenses.release') }}</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="section-title">{{ t('licenses.deliveryRecords') }}</div>
      <div v-if="deliveries" class="delivery-summary">
        <el-tag size="small">{{ t('licenses.totalCount', { n: deliveries.total }) }}</el-tag>
        <el-tag size="small" type="success">{{ t('licenses.sentCount', { n: deliveries.sent }) }}</el-tag>
        <el-tag v-if="deliveries.failed" size="small" type="danger">{{ t('licenses.failedCount', { n: deliveries.failed }) }}</el-tag>
        <span v-if="deliveries.last_sent_at" class="hint">
          {{ t('licenses.lastSentAt', { at: fmt(deliveries.last_sent_at) }) }}
        </span>
      </div>
      <el-table
        v-if="deliveries && deliveries.records.length"
        :data="deliveries.records"
        size="small"
      >
        <el-table-column prop="to_masked" :label="t('licenses.colRecipient')" min-width="170" />
        <el-table-column prop="code_count" :label="t('licenses.colCodeCount')" width="70" />
        <el-table-column :label="t('licenses.colResult')" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'sent' ? 'success' : 'danger'">
              {{ row.status === 'sent' ? t('licenses.delivered') : t('licenses.failed') }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('licenses.colTime')" width="170">
          <template #default="{ row }">{{ fmt(row.created_at) }}</template>
        </el-table-column>
        <el-table-column :label="t('licenses.colError')" min-width="160">
          <template #default="{ row }">{{ row.error ?? '-' }}</template>
        </el-table-column>
      </el-table>
      <el-empty
        v-else-if="deliveries"
        :description="t('licenses.noDeliveries')"
        :image-size="60"
      />

      <div class="section-title">{{ t('licenses.lifecycle') }}</div>
      <el-timeline v-if="timeline.length">
        <el-timeline-item v-for="(e, i) in timeline" :key="i" :timestamp="fmt(e.at)">
          {{ timelineLabel(e.type) }}
          <span v-if="e.detail?.reason" class="hint"> · {{ e.detail.reason }}</span>
        </el-timeline-item>
      </el-timeline>
      <el-empty v-else :description="t('licenses.noTimeline')" :image-size="60" />
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errMsg, idemKey } from '../api';
import { useAuth } from '../store';
import { useI18n } from 'vue-i18n';

const auth = useAuth();
const { t } = useI18n();

interface LicenseRow {
  id: string;
  active_devices?: number;
  device_limit?: number;
  code_masked: string;
  kind: string;
  status: string;
  issued_at: string | null;
  activated_at?: string | null;
  expires_at: string | null;
}

interface LicenseDetail extends LicenseRow {
  features: string[];
  device_limit: number;
  seat_limit: number | null;
}

interface Activation {
  activation_id: string;
  activated_at: string;
  last_seen_at: string | null;
  device: { id: string; platform: string; display_name: string | null } | null;
}

const rows = ref<LicenseRow[]>([]);
const activations = ref<Activation[]>([]);
const timeline = ref<Array<{ at: string; type: string; detail: Record<string, unknown> }>>([]);
const deliveries = ref<{
  total: number;
  sent: number;
  failed: number;
  last_sent_at: string | null;
  records: Array<{
    id: string;
    to_masked: string;
    code_count: number;
    status: string;
    error: string | null;
    created_at: string;
  }>;
} | null>(null);

const TIMELINE_TYPES = [
  'issued',
  'activated',
  'device_activated',
  'device_released',
  'renewed',
  'suspended',
  'revoked',
  'expire_warning',
] as const;

function timelineLabel(type: string): string {
  return (TIMELINE_TYPES as readonly string[]).includes(type)
    ? t(`licenses.timeline.${type}`)
    : type;
}
const loading = ref(false);
const detailLoading = ref(false);
const drawer = ref(false);
const status = ref('');
const detail = ref<LicenseDetail | null>(null);
const statuses = ['issued', 'activated', 'suspended', 'revoked', 'expired'];

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.get('/admin/v1/licenses', {
      params: { limit: 200, status: status.value || undefined },
    });
    rows.value = data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function openDetail(row: LicenseRow): Promise<void> {
  drawer.value = true;
  detailLoading.value = true;
  try {
    const [d, a] = await Promise.all([
      api.get(`/admin/v1/licenses/${row.id}`),
      api.get(`/admin/v1/licenses/${row.id}/activations`),
    ]);
    detail.value = d.data.data;
    activations.value = a.data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    detailLoading.value = false;
  }
}

async function renew(row: LicenseRow): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      t('licenses.renewDays'),
      t('licenses.renewTitle', { code: row.code_masked }),
      {
        inputValue: '365',
        inputPattern: /^[1-9]\d*$/,
        inputErrorMessage: t('licenses.renewInvalid'),
      },
    );
    await api.post(
      `/admin/v1/licenses/${row.id}/renew`,
      { days: Number(value), order_ref: `web-${Date.now()}` },
      { headers: { 'Idempotency-Key': idemKey() } },
    );
    ElMessage.success(t('licenses.renewed'));
    await load();
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errMsg(e));
  }
}

async function revoke(row: LicenseRow): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      t('licenses.revokeReason'),
      t('licenses.revokeTitle', { code: row.code_masked }),
      { inputValidator: (v: string) => (v && v.trim().length > 0) || t('licenses.reasonRequired') },
    );
    await api.post(
      `/admin/v1/licenses/${row.id}/revoke`,
      { reason: value },
      { headers: { 'Idempotency-Key': idemKey() } },
    );
    ElMessage.success(t('licenses.revokedOk'));
    await load();
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errMsg(e));
  }
}

async function release(row: Activation): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      t('licenses.releaseReason'),
      row.device?.display_name || t('licenses.releaseTitle'),
      { inputValidator: (v: string) => (v && v.trim().length > 0) || t('licenses.reasonRequired') },
    );
    await api.post(`/admin/v1/activations/${row.activation_id}/release`, { reason: value });
    ElMessage.success(t('licenses.released'));
    // 列表里的设备数也要跟着变, 否则看起来"解绑了但还是已激活"
    await load();
    if (detail.value) await openDetail(detail.value);
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errMsg(e));
  }
}

function statusLabel(status: string): string {
  const known = ['issued', 'activated', 'suspended', 'revoked', 'expired', 'active'];
  return known.includes(status) ? t(`licenses.status.${status}`) : status;
}

function tagType(status: string): string {
  if (status === 'activated') return 'success';
  if (status === 'revoked') return 'danger';
  if (status === 'expired') return 'info';
  if (status === 'suspended') return 'warning';
  return 'primary';
}

function fmt(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '-';
}

onMounted(load);

async function deliver(): Promise<void> {
  if (!detail.value) return;
  let to = '';
  try {
    const r = await ElMessageBox.prompt(
      t('licenses.deliverPrompt'),
      t('licenses.deliverTitle'),
      { inputPlaceholder: 'customer@example.com', inputValue: '' },
    );
    to = (r.value ?? '').trim();
  } catch {
    return;
  }
  try {
    const { data } = await api.post(`/admin/v1/licenses/${detail.value.id}/deliver`, {
      to: to || null,
    });
    const d = data.data;
    if (d.sent) ElMessage.success(t('licenses.deliverOk', { to: d.to }));
    else ElMessage.error(t('licenses.deliverFail', { err: d.error ?? t('licenses.unknownReason') }));
    const rec = await api.get(`/admin/v1/licenses/${detail.value.id}/deliveries`);
    deliveries.value = rec.data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}
</script>

<style scoped>
.page-card { border-radius: 8px; }
.page-head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
.page-head h2 { margin: 0; font-size: 20px; color: #1f2937; }
.page-head p { margin: 6px 0 0; color: #6b7280; font-size: 13px; }
.filters { display: flex; gap: 10px; flex-wrap: wrap; }
.section-title { margin: 24px 0 10px; font-size: 15px; font-weight: 600; color: #374151; }
:deep(.el-table__row) { cursor: pointer; }
@media (max-width: 760px) {
  .page-head { flex-direction: column; }
}
.drawer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 16px 0 4px;
}
.drawer-actions .hint {
  color: #909399;
  font-size: 12px;
}
.delivery-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.delivery-summary .hint {
  color: #909399;
  font-size: 12px;
}
</style>