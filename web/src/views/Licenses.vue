<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>授权码</h2>
          <p>查看激活状态、绑定设备和有效期，执行续期、吊销与设备解绑。</p>
        </div>
        <div class="filters">
          <el-select v-model="status" placeholder="全部状态" clearable style="width: 150px" @change="load">
            <el-option v-for="s in statuses" :key="s" :label="statusLabel(s)" :value="s" />
          </el-select>
          <el-button :loading="loading" @click="load">刷新</el-button>
        </div>
      </div>
    </template>

    <el-table :data="rows" v-loading="loading" size="small" @row-click="openDetail">
      <el-table-column prop="code_masked" label="授权码" min-width="250" />
      <el-table-column prop="kind" label="类型" width="110" />
      <el-table-column prop="status" label="状态" width="120">
        <template #default="{ row }">
          <el-tag :type="tagType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="激活时间" width="180">
        <template #default="{ row }">{{ fmt(row.activated_at) }}</template>
      </el-table-column>
      <el-table-column label="到期时间" width="180">
        <template #default="{ row }">{{ fmt(row.expires_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="220">
        <template #default="{ row }">
          <el-button size="small" type="primary" link @click.stop="openDetail(row)">详情/设备</el-button>
          <el-button
            v-if="auth.can('license:renew')"
            size="small"
            type="primary"
            link
            :disabled="row.status === 'revoked' || row.status === 'issued'"
            @click.stop="renew(row)"
          >
            续期
          </el-button>
          <el-button
            v-if="auth.can('license:revoke:approve')"
            size="small"
            type="danger"
            link
            :disabled="row.status === 'revoked'"
            @click.stop="revoke(row)"
          >
            吊销
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-drawer v-model="drawer" size="680px" :title="detail?.code_masked ?? '授权详情'">
    <div v-loading="detailLoading">
      <el-descriptions v-if="detail" :column="2" border size="small">
        <el-descriptions-item label="状态">{{ statusLabel(detail.status) }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ detail.kind }}</el-descriptions-item>
        <el-descriptions-item label="设备上限">{{ detail.device_limit }}</el-descriptions-item>
        <el-descriptions-item label="席位上限">{{ detail.seat_limit ?? '不限' }}</el-descriptions-item>
        <el-descriptions-item label="激活时间">{{ fmt(detail.activated_at) }}</el-descriptions-item>
        <el-descriptions-item label="到期时间">{{ fmt(detail.expires_at) }}</el-descriptions-item>
        <el-descriptions-item label="功能权益" :span="2">
          {{ detail.features?.join(', ') || '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="许可证 ID" :span="2">{{ detail.id }}</el-descriptions-item>
      </el-descriptions>

      <div class="drawer-actions" v-if="auth.can('license:issue') && detail">
        <el-button size="small" type="primary" @click="deliver">发送给客户</el-button>
        <span class="hint">不填邮箱时发给该授权绑定的组织联系人</span>
      </div>

      <div class="section-title">当前设备</div>
      <el-table :data="activations" size="small" empty-text="暂无设备激活">
        <el-table-column label="设备" min-width="170">
          <template #default="{ row }">
            {{ row.device?.display_name || row.device?.id || '组织席位' }}
          </template>
        </el-table-column>
        <el-table-column label="平台" width="110">
          <template #default="{ row }">{{ row.device?.platform || '-' }}</template>
        </el-table-column>
        <el-table-column label="最近心跳" width="170">
          <template #default="{ row }">{{ fmt(row.last_seen_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button type="danger" link size="small" @click="release(row)">解绑</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="section-title">交付记录</div>
      <div v-if="deliveries" class="delivery-summary">
        <el-tag size="small">共 {{ deliveries.total }} 次</el-tag>
        <el-tag size="small" type="success">成功 {{ deliveries.sent }}</el-tag>
        <el-tag v-if="deliveries.failed" size="small" type="danger">失败 {{ deliveries.failed }}</el-tag>
        <span v-if="deliveries.last_sent_at" class="hint">
          最近成功 {{ fmt(deliveries.last_sent_at) }}
        </span>
      </div>
      <el-table
        v-if="deliveries && deliveries.records.length"
        :data="deliveries.records"
        size="small"
      >
        <el-table-column prop="to_masked" label="收件人" min-width="170" />
        <el-table-column prop="code_count" label="码数" width="70" />
        <el-table-column label="结果" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'sent' ? 'success' : 'danger'">
              {{ row.status === 'sent' ? '已送达' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ fmt(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="错误" min-width="160">
          <template #default="{ row }">{{ row.error ?? '-' }}</template>
        </el-table-column>
      </el-table>
      <el-empty
        v-else-if="deliveries"
        description="还没有交付记录"
        :image-size="60"
      />

      <div class="section-title">生命周期</div>
      <el-timeline v-if="timeline.length">
        <el-timeline-item v-for="(e, i) in timeline" :key="i" :timestamp="fmt(e.at)">
          {{ timelineLabel(e.type) }}
          <span v-if="e.detail?.reason" class="hint"> · {{ e.detail.reason }}</span>
        </el-timeline-item>
      </el-timeline>
      <el-empty v-else description="暂无记录" :image-size="60" />
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errMsg, idemKey } from '../api';
import { useAuth } from '../store';

const auth = useAuth();

interface LicenseRow {
  id: string;
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

const TIMELINE_LABELS: Record<string, string> = {
  issued: '授权码生成',
  activated: '首次激活',
  device_activated: '设备绑定',
  device_released: '设备解绑',
  renewed: '续期',
  suspended: '暂停',
  revoked: '吊销',
  expire_warning: '到期提醒',
};

function timelineLabel(type: string): string {
  return TIMELINE_LABELS[type] ?? type;
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
    const { value } = await ElMessageBox.prompt('续期天数', `续期 ${row.code_masked}`, {
      inputValue: '365',
      inputPattern: /^[1-9]\d*$/,
      inputErrorMessage: '请输入正整数天数',
    });
    await api.post(
      `/admin/v1/licenses/${row.id}/renew`,
      { days: Number(value), order_ref: `web-${Date.now()}` },
      { headers: { 'Idempotency-Key': idemKey() } },
    );
    ElMessage.success('续期成功');
    await load();
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errMsg(e));
  }
}

async function revoke(row: LicenseRow): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      '吊销原因（必填，将进入审计日志）',
      `吊销 ${row.code_masked}`,
      { inputValidator: (v: string) => (v && v.trim().length > 0) || '原因不能为空' },
    );
    await api.post(
      `/admin/v1/licenses/${row.id}/revoke`,
      { reason: value },
      { headers: { 'Idempotency-Key': idemKey() } },
    );
    ElMessage.success('已吊销，客户端下次校验立即失效');
    await load();
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errMsg(e));
  }
}

async function release(row: Activation): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      '解绑原因（必填）',
      row.device?.display_name || '解绑设备',
      { inputValidator: (v: string) => (v && v.trim().length > 0) || '原因不能为空' },
    );
    await api.post(`/admin/v1/activations/${row.activation_id}/release`, { reason: value });
    ElMessage.success('设备已解绑，客户端 token 已立即失效');
    if (detail.value) await openDetail(detail.value);
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errMsg(e));
  }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    issued: '未激活',
    activated: '已激活',
    suspended: '已暂停',
    revoked: '已吊销',
    expired: '已过期',
    active: '正常',
  };
  return labels[status] ?? status;
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
      '收件邮箱（留空则发送给该授权绑定的组织联系人）',
      '发送授权码给客户',
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
    if (d.sent) ElMessage.success(`已发送到 ${d.to}`);
    else ElMessage.error(`发送失败: ${d.error ?? '未知原因'}`);
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