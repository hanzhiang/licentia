<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>待批准设备</h2>
          <p>客户端上报设备后生成短码，用户把短码报给你，批准后客户端自动完成激活。</p>
        </div>
        <div>
          <el-select v-model="status" style="width: 120px; margin-right: 8px" @change="load">
            <el-option label="待批准" value="pending" />
            <el-option label="已批准" value="approved" />
            <el-option label="已拒绝" value="rejected" />
            <el-option label="已过期" value="expired" />
          </el-select>
          <el-button :loading="loading" @click="load">刷新</el-button>
        </div>
      </div>
    </template>

    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="request_code" label="设备码" width="130" />
      <el-table-column prop="product_name" label="产品" min-width="150" />
      <el-table-column prop="platform" label="平台" width="110" />
      <el-table-column prop="app_version" label="版本" width="90" />
      <el-table-column prop="user_id" label="用户标识" min-width="120">
        <template #default="{ row }">{{ row.user_id ?? '-' }}</template>
      </el-table-column>
      <el-table-column label="申请时间" width="170">
        <template #default="{ row }">{{ fmt(row.created_at) }}</template>
      </el-table-column>
      <el-table-column label="过期时间" width="170">
        <template #default="{ row }">{{ fmt(row.expires_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="150">
        <template #default="{ row }">
          <template v-if="row.status === 'pending' && auth.can('license:issue')">
            <el-button link type="primary" @click="openApprove(row)">批准</el-button>
            <el-button link type="danger" @click="reject(row)">拒绝</el-button>
          </template>
          <span v-else class="note">{{ row.decision_note ?? row.status }}</span>
        </template>
      </el-table-column>
    </el-table>

    <el-empty v-if="!loading && rows.length === 0" description="没有待处理的设备申请" />
  </el-card>

  <el-dialog v-model="approveOpen" title="批准设备激活" width="480px">
    <el-form label-width="96px">
      <el-form-item label="设备码">
        <span>{{ current?.request_code }}</span>
      </el-form-item>
      <el-form-item label="产品">
        <span>{{ current?.product_name }}</span>
      </el-form-item>
      <el-form-item label="应用策略">
        <el-select v-model="policyId" placeholder="选择策略" style="width: 100%">
          <el-option
            v-for="p in policies"
            :key="p.id"
            :label="`${p.name}（${p.duration_days ? p.duration_days + ' 天' : '永久'} / ${p.device_limit} 设备）`"
            :value="p.id"
          />
        </el-select>
      </el-form-item>
      <p class="tip">批准后会按该策略生成一张新授权码，绑定到申请设备。</p>
    </el-form>
    <template #footer>
      <el-button @click="approveOpen = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!policyId" @click="approve">
        批准
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';

const auth = useAuth();

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
    ElMessage.success('已批准，客户端下次轮询即可拿到授权码');
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
    const r = await ElMessageBox.prompt('拒绝原因（客户端会看到）', `拒绝 ${row.request_code}`, {
      inputPlaceholder: '如：未购买 / 设备信息异常',
    });
    note = (r.value ?? '').trim();
  } catch {
    return;
  }
  try {
    await api.post(`/admin/v1/device-requests/${row.id}/reject`, { note: note || null });
    ElMessage.success('已拒绝');
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
