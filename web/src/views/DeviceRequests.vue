<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>{{ t('deviceRequests.title') }}</h2>
          <p>{{ t('deviceRequests.subtitle') }}</p>
        </div>
        <div>
          <el-select v-model="status" style="width: 120px; margin-right: 8px" @change="load">
            <el-option :label="t('deviceRequests.filterPending')" value="pending" />
            <el-option :label="t('deviceRequests.filterApproved')" value="approved" />
            <el-option :label="t('deviceRequests.filterRejected')" value="rejected" />
            <el-option :label="t('deviceRequests.filterExpired')" value="expired" />
          </el-select>
          <el-button :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
        </div>
      </div>
    </template>

    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="request_code" :label="t('deviceRequests.colCode')" width="130" />
      <el-table-column prop="product_name" :label="t('deviceRequests.colProduct')" min-width="150" />
      <el-table-column prop="platform" :label="t('deviceRequests.colPlatform')" width="110" />
      <el-table-column prop="app_version" :label="t('deviceRequests.colVersion')" width="90" />
      <el-table-column prop="user_id" :label="t('deviceRequests.colUser')" min-width="120">
        <template #default="{ row }">{{ row.user_id ?? '-' }}</template>
      </el-table-column>
      <el-table-column :label="t('deviceRequests.colRequestedAt')" width="170">
        <template #default="{ row }">{{ fmt(row.created_at) }}</template>
      </el-table-column>
      <el-table-column :label="t('deviceRequests.colExpiresAt')" width="170">
        <template #default="{ row }">{{ fmt(row.expires_at) }}</template>
      </el-table-column>
      <el-table-column :label="t('common.actions')" width="150">
        <template #default="{ row }">
          <template v-if="row.status === 'pending' && auth.can('license:issue')">
            <el-button link type="primary" @click="openApprove(row)">{{ t('deviceRequests.approve') }}</el-button>
            <el-button link type="danger" @click="reject(row)">{{ t('deviceRequests.reject') }}</el-button>
          </template>
          <span v-else class="note">{{ row.decision_note ?? row.status }}</span>
        </template>
      </el-table-column>
    </el-table>

    <el-empty v-if="!loading && rows.length === 0" :description="t('deviceRequests.empty')" />
  </el-card>

  <el-dialog v-model="approveOpen" :title="t('deviceRequests.dialogTitle')" width="480px">
    <el-form label-width="96px">
      <el-form-item :label="t('deviceRequests.fieldCode')">
        <span>{{ current?.request_code }}</span>
      </el-form-item>
      <el-form-item :label="t('deviceRequests.fieldProduct')">
        <span>{{ current?.product_name }}</span>
      </el-form-item>
      <el-form-item :label="t('deviceRequests.fieldPolicy')">
        <el-select v-model="policyId" :placeholder="t('deviceRequests.policyPlaceholder')" style="width: 100%">
          <el-option
            v-for="p in policies"
            :key="p.id"
            :label="policyLabel(p)"
            :value="p.id"
          />
        </el-select>
      </el-form-item>
      <p class="tip">{{ t('deviceRequests.tip') }}</p>
    </el-form>
    <template #footer>
      <el-button @click="approveOpen = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" :disabled="!policyId" @click="approve">
        {{ t('deviceRequests.approve') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';
import { useI18n } from 'vue-i18n';

const auth = useAuth();
const { t } = useI18n();

interface DeviceRequest {
  id: string;
  request_code: string;
  product_id: string;
  product_code: string;
  product_name: string;
  platform: string;
  app_version: string | null;
  user_id: string | null;
  status: string;
  created_at: string;
  expires_at: string;
  decision_note: string | null;
}

interface Policy {
  id: string;
  name: string;
  product_id: string;
  duration_days: number | null;
  device_limit: number;
  status: string;
}

const rows = ref<DeviceRequest[]>([]);
const policies = ref<Policy[]>([]);
const loading = ref(false);
const saving = ref(false);
const status = ref('pending');
const approveOpen = ref(false);
const current = ref<DeviceRequest | null>(null);
const policyId = ref('');

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

async function loadPolicies(): Promise<void> {
  try {
    const { data } = await api.get('/admin/v1/catalog');
    policies.value = data.data.policies.filter((p: Policy) => p.status === 'active');
  } catch {
    /* 无权限时忽略 */
  }
}

function policyLabel(p: Policy): string {
  return t('deviceRequests.policyOption', {
    name: p.name,
    days: p.duration_days
      ? t('deviceRequests.days', { n: p.duration_days })
      : t('deviceRequests.perpetual'),
    devices: p.device_limit,
  });
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.get('/admin/v1/device-requests', { params: { status: status.value } });
    rows.value = data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

function openApprove(row: DeviceRequest): void {
  current.value = row;
  policyId.value = '';
  // 策略必须与申请的产品一致, 否则服务端会拒绝
  void loadPolicies().then(() => {
    policies.value = policies.value.filter((p) => p.product_id === row.product_id);
    if (policies.value.length === 1) policyId.value = policies.value[0]!.id;
  });
  approveOpen.value = true;
}

async function approve(): Promise<void> {
  if (!current.value || !policyId.value) return;
  saving.value = true;
  try {
    await api.post(`/admin/v1/device-requests/${current.value.id}/approve`, {
      policy_id: policyId.value,
    });
    ElMessage.success(t('deviceRequests.approved'));
    approveOpen.value = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

async function reject(row: DeviceRequest): Promise<void> {
  let note = '';
  try {
    const r = await ElMessageBox.prompt(
      t('deviceRequests.rejectPrompt'),
      t('deviceRequests.rejectTitle', { code: row.request_code }),
      { inputPlaceholder: t('deviceRequests.rejectPlaceholder') },
    );
    note = (r.value ?? '').trim();
  } catch {
    return;
  }
  try {
    await api.post(`/admin/v1/device-requests/${row.id}/reject`, { note: note || null });
    ElMessage.success(t('deviceRequests.rejected'));
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

onMounted(load);
</script>

<style scoped>
.note {
  color: #909399;
  font-size: 12px;
}
.tip {
  color: #909399;
  font-size: 12px;
  margin: 4px 0 0 96px;
}
</style>
