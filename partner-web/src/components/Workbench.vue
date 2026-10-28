<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">LP</span>
        <div>
          <strong>渠道发码工作台</strong>
          <small>授权码发放与批次管理</small>
        </div>
      </div>
      <div class="account">
        <span>{{ user.email }}</span>
        <el-button link type="danger" @click="$emit('logout')">退出</el-button>
      </div>
    </header>

    <main class="workspace">
      <section class="heading">
        <div>
          <p class="eyebrow">PARTNER CONSOLE</p>
          <h1>发放授权码</h1>
          <p>选择已授权的产品和策略，生成可交付给客户的授权码。</p>
        </div>
        <div class="summary">
          <div><strong>{{ batches.length }}</strong><span>我的批次</span></div>
          <div><strong>{{ totalIssued }}</strong><span>累计发码</span></div>
        </div>
      </section>

      <el-tabs v-model="tab" class="tabs">
        <el-tab-pane label="发放授权码" name="issue">
          <div class="issue-grid">
            <section class="panel">
              <h2>发码参数</h2>
              <el-form label-position="top">
                <el-form-item label="产品">
                  <el-select v-model="productId" style="width: 100%" @change="productChanged">
                    <el-option
                      v-for="product in products"
                      :key="product.id"
                      :label="`${product.name} (${product.code})`"
                      :value="product.id"
                    />
                  </el-select>
                </el-form-item>
                <el-form-item label="授权策略">
                  <el-select v-model="policyId" style="width: 100%">
                    <el-option
                      v-for="policy in productPolicies"
                      :key="policy.id"
                      :label="`${policy.name} · ${policy.duration_days ?? '永久'}`"
                      :value="policy.id"
                    />
                  </el-select>
                </el-form-item>
                <el-form-item label="渠道">
                  <el-select v-model="channelId" clearable style="width: 100%">
                    <el-option
                      v-for="channel in channels"
                      :key="channel.id"
                      :label="`${channel.name} (${channel.code})`"
                      :value="channel.id"
                    />
                  </el-select>
                </el-form-item>
                <div class="two-cols">
                  <el-form-item label="数量">
                    <el-input-number v-model="quantity" :min="1" :max="100000" style="width: 100%" />
                  </el-form-item>
                  <el-form-item label="备注">
                    <el-input v-model="note" placeholder="客户或订单备注" />
                  </el-form-item>
                </div>
                <div v-if="selectedPolicy" class="policy-facts">
                  <span>设备 {{ selectedPolicy.device_limit }} 台</span>
                  <span>席位 {{ selectedPolicy.seat_limit ?? '不限' }}</span>
                  <span>离线 {{ selectedPolicy.offline_window_days }} 天</span>
                </div>
                <el-button
                  type="primary"
                  class="issue-button"
                  :loading="issuing"
                  :disabled="!productId || !policyId"
                  @click="issue"
                >
                  生成 {{ quantity }} 个授权码
                </el-button>
              </el-form>
            </section>

            <section class="panel result-panel">
              <template v-if="lastResult">
                <div class="result-head">
                  <div>
                    <p class="eyebrow success">ISSUED</p>
                    <h2>{{ lastResult.issued_count }} 个授权码已生成</h2>
                  </div>
                  <el-tag type="success" effect="plain">{{ lastResult.status }}</el-tag>
                </div>
                <p class="warning">明文仅在本页展示。请立即复制或下载 CSV，关闭后只能重新导出自己创建的批次。</p>
                <el-input
                  v-if="lastResult.codes?.length"
                  :model-value="lastResult.codes.join('\n')"
                  type="textarea"
                  :rows="12"
                  readonly
                  class="code-box"
                />
                <div class="result-actions">
                  <el-button v-if="lastResult.codes?.length" @click="copyCodes">复制全部</el-button>
                  <el-button type="primary" @click="download(lastResult.batch_id)">下载 CSV</el-button>
                </div>
              </template>
              <div v-else class="empty-result">
                <span>尚未生成</span>
                <p>完成左侧参数后，这里会显示本次发码结果。</p>
              </div>
            </section>
          </div>
        </el-tab-pane>

        <el-tab-pane label="我的批次" name="history">
          <section class="panel">
            <div class="table-head">
              <div>
                <h2>我的发码记录</h2>
                <p>这里只显示当前渠道账号创建的批次。</p>
              </div>
              <el-button :loading="loadingBatches" @click="loadBatches">刷新</el-button>
            </div>
            <el-table :data="batches" v-loading="loadingBatches" size="small">
              <el-table-column prop="code" label="批次号" min-width="190" />
              <el-table-column prop="quantity" label="数量" width="80" />
              <el-table-column prop="issued_count" label="成功" width="80" />
              <el-table-column label="状态" width="120">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.status === 'completed' ? 'success' : 'warning'">
                    {{ row.status }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="note" label="备注" min-width="160" />
              <el-table-column label="创建时间" width="170">
                <template #default="{ row }">{{ fmt(row.created_at) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="110">
                <template #default="{ row }">
                  <el-button link type="primary" @click="download(row.id)">下载码表</el-button>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </el-tab-pane>

        <el-tab-pane label="开发者接入" name="api">
          <section class="panel api-panel">
            <h2>用程序发码</h2>
            <p>开发者可用渠道账号登录取得 access token，再调用同一套发码接口。Access token 过期后使用 refresh token 轮换。</p>
            <h3>1. 登录</h3>
            <pre>POST /admin/v1/auth/login
{"email":"partner@demo.local","password":"..."}</pre>
            <h3>2. 发起批量发码</h3>
            <pre>POST /admin/v1/batches
Authorization: Bearer &lt;access_token&gt;
Idempotency-Key: &lt;uuid&gt;

{
  "product_id": "...",
  "policy_id": "...",
  "channel_id": "...",
  "quantity": 100,
  "note": "渠道订单号 20261028"
}</pre>
            <h3>3. 导出自己创建的批次</h3>
            <pre>GET /admin/v1/batches/&lt;batch_id&gt;/export
Authorization: Bearer &lt;access_token&gt;</pre>
            <el-alert
              type="info"
              :closable="false"
              title="渠道账号只能查询和导出自己创建的批次。产品、策略配置和审计接口不会对该角色开放。"
            />
          </section>
        </el-tab-pane>
      </el-tabs>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errMsg, idempotencyKey } from '../api';
import type { SessionUser } from '../session';

defineProps<{ user: SessionUser }>();
defineEmits<{ logout: [] }>();

interface Product {
  id: string;
  code: string;
  name: string;
}

interface Policy {
  id: string;
  product_id: string;
  name: string;
  duration_days: number | null;
  device_limit: number;
  seat_limit: number | null;
  offline_window_days: number;
}

interface Channel {
  id: string;
  code: string;
  name: string;
}

interface Batch {
  id: string;
  code: string;
  quantity: number;
  issued_count: number;
  status: string;
  note: string | null;
  created_at: string;
}

interface IssueResult {
  batch_id: string;
  status: string;
  issued_count: number;
  failed_count: number;
  codes?: string[];
}

const tab = ref('issue');
const products = ref<Product[]>([]);
const policies = ref<Policy[]>([]);
const channels = ref<Channel[]>([]);
const productId = ref('');
const policyId = ref('');
const channelId = ref('');
const quantity = ref(10);
const note = ref('');
const issuing = ref(false);
const loadingBatches = ref(false);
const batches = ref<Batch[]>([]);
const lastResult = ref<IssueResult | null>(null);

const productPolicies = computed(() =>
  policies.value.filter((policy) => policy.product_id === productId.value),
);
const selectedPolicy = computed(() => policies.value.find((policy) => policy.id === policyId.value));
const totalIssued = computed(() =>
  batches.value.reduce((sum, batch) => sum + Number(batch.issued_count), 0),
);

async function loadCatalog(): Promise<void> {
  try {
    const { data } = await api.get('/admin/v1/catalog');
    products.value = data.data.products;
    policies.value = data.data.policies;
    channels.value = data.data.channels;
    if (products.value[0]) {
      productId.value = products.value[0].id;
      productChanged();
    }
    if (channels.value[0]) channelId.value = channels.value[0].id;
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

function productChanged(): void {
  policyId.value = productPolicies.value[0]?.id ?? '';
}

async function loadBatches(): Promise<void> {
  loadingBatches.value = true;
  try {
    const { data } = await api.get('/admin/v1/batches', {
      params: { mine: true, limit: 200 },
    });
    batches.value = data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loadingBatches.value = false;
  }
}

async function issue(): Promise<void> {
  issuing.value = true;
  try {
    const { data } = await api.post(
      '/admin/v1/batches',
      {
        product_id: productId.value,
        policy_id: policyId.value,
        channel_id: channelId.value || null,
        quantity: quantity.value,
        note: note.value || null,
      },
      { headers: { 'Idempotency-Key': idempotencyKey() } },
    );
    lastResult.value = data.data as IssueResult;
    ElMessage.success(`已生成 ${lastResult.value.issued_count} 个授权码`);
    await loadBatches();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    issuing.value = false;
  }
}

async function copyCodes(): Promise<void> {
  if (!lastResult.value?.codes?.length) return;
  await navigator.clipboard.writeText(lastResult.value.codes.join('\n'));
  ElMessage.success('授权码已复制');
}

async function download(batchId: string): Promise<void> {
  try {
    const response = await api.get(`/admin/v1/batches/${batchId}/export`, {
      responseType: 'blob',
    });
    const url = URL.createObjectURL(response.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `license-${batchId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

function fmt(value: string): string {
  return new Date(value).toLocaleString();
}

onMounted(async () => {
  await Promise.all([loadCatalog(), loadBatches()]);
});
</script>

<style scoped>
.app-shell { min-height: 100vh; }
.topbar {
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 28px;
  background: #fff;
  border-bottom: 1px solid #dfe7e5;
}
.brand { display: flex; align-items: center; gap: 12px; }
.brand-mark {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  background: #147d72;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
}
.brand div { display: flex; flex-direction: column; }
.brand strong { font-size: 15px; }
.brand small { color: #7b8782; margin-top: 2px; }
.account { display: flex; align-items: center; gap: 14px; color: #5e6a65; }
.workspace { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 34px 0 50px; }
.heading { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 20px; }
.eyebrow { margin: 0 0 6px; color: #147d72; font-size: 11px; font-weight: 700; }
.eyebrow.success { color: #2c8b57; }
.heading h1 { margin: 0; font-size: 30px; letter-spacing: 0; }
.heading p { margin: 8px 0 0; color: #718079; }
.summary { display: flex; gap: 28px; }
.summary div { display: flex; flex-direction: column; align-items: flex-end; }
.summary strong { font-size: 24px; color: #1d2924; }
.summary span { color: #7b8782; font-size: 12px; }
.tabs { padding: 0 22px 22px; border: 1px solid #dfe7e5; border-radius: 8px; background: #fff; }
.issue-grid { display: grid; grid-template-columns: 1fr 1.2fr; gap: 22px; }
.panel { border: 1px solid #e1e8e6; border-radius: 8px; padding: 22px; }
.panel h2 { margin: 0 0 18px; font-size: 18px; }
.two-cols { display: grid; grid-template-columns: 1fr 1.3fr; gap: 14px; }
.policy-facts { display: flex; flex-wrap: wrap; gap: 14px; margin: 4px 0 18px; padding: 10px 12px; background: #f2f8f6; color: #4f625a; font-size: 12px; }
.issue-button { width: 100%; }
.result-panel { background: #fbfdfc; }
.result-head { display: flex; justify-content: space-between; gap: 18px; }
.result-head h2 { margin-bottom: 8px; }
.warning { color: #8a6423; background: #fff8e6; padding: 10px 12px; font-size: 12px; line-height: 1.6; }
.code-box :deep(textarea) { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.result-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }
.empty-result { min-height: 380px; display: grid; place-content: center; text-align: center; color: #8b9792; }
.empty-result span { font-size: 20px; color: #596660; }
.table-head { display: flex; justify-content: space-between; align-items: flex-start; }
.table-head p { margin: -10px 0 18px; color: #7b8782; }
.api-panel { max-width: 820px; }
.api-panel > p { color: #67746e; line-height: 1.7; }
.api-panel h3 { margin: 22px 0 8px; font-size: 14px; }
pre { margin: 0; padding: 13px 15px; border-radius: 6px; background: #17211d; color: #d8e7df; overflow: auto; font-size: 12px; line-height: 1.7; }
@media (max-width: 800px) {
  .topbar { padding: 0 14px; }
  .brand small { display: none; }
  .workspace { width: calc(100% - 24px); padding-top: 22px; }
  .heading { align-items: flex-start; flex-direction: column; gap: 18px; }
  .summary { align-self: stretch; justify-content: space-between; }
  .summary div { align-items: flex-start; }
  .tabs { padding: 0 12px 14px; }
  .issue-grid { grid-template-columns: 1fr; }
  .two-cols { grid-template-columns: 1fr; }
}
</style>
