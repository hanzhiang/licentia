<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>批量发码</h2>
          <p>按已配置的产品、授权策略和渠道生成授权码。明文仅展示一次。</p>
        </div>
        <el-button :loading="loadingList" @click="loadAll">刷新</el-button>
      </div>
    </template>

    <el-alert
      v-if="!catalog.products.length || !catalog.policies.length"
      type="warning"
      show-icon
      :closable="false"
      title="请先在「产品与策略」中创建产品、授权策略和渠道。"
      class="notice"
    />

    <el-form v-if="auth.can('license:issue')" label-position="top" class="issue-form">
      <el-form-item label="产品">
        <el-select v-model="productId" placeholder="选择产品" style="width: 100%" @change="productChanged">
          <el-option
            v-for="p in catalog.products"
            :key="p.id"
            :label="`${p.name} (${p.code})`"
            :value="p.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="授权策略">
        <el-select v-model="policyId" placeholder="选择策略" style="width: 100%">
          <el-option
            v-for="p in productPolicies"
            :key="p.id"
            :label="`${p.name} · ${p.kind} · ${p.duration_days ?? '永久'}`"
            :value="p.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="渠道">
        <el-select v-model="channelId" clearable placeholder="可选" style="width: 100%">
          <el-option
            v-for="c in catalog.channels"
            :key="c.id"
            :label="`${c.name} (${c.code})`"
            :value="c.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="数量">
        <el-input-number v-model="quantity" :min="1" :max="100000" style="width: 100%" />
      </el-form-item>
      <el-form-item label="备注" class="note-field">
        <el-input v-model="note" placeholder="如：2026 春季渠道铺货" />
      </el-form-item>
      <el-form-item label=" ">
        <el-button
          type="primary"
          :loading="loading"
          :disabled="!productId || !policyId"
          @click="issue"
        >
          生成授权码
        </el-button>
      </el-form-item>
    </el-form>

    <div v-if="selectedPolicy" class="policy-summary">
      <span>设备 {{ selectedPolicy.device_limit }} 台</span>
      <span>席位 {{ selectedPolicy.seat_limit ?? '不限' }}</span>
      <span>离线 {{ selectedPolicy.offline_window_days }} 天</span>
      <span>权益 {{ selectedPolicy.features.join(' / ') }}</span>
    </div>

    <el-alert v-if="lastCodes.length" type="success" :closable="false" class="codes">
      <template #title>
        <div class="codes-title">
          <span>本批 {{ lastCodes.length }} 个码</span>
          <el-button link type="primary" @click="copyCodes">复制全部</el-button>
        </div>
      </template>
      <div class="code-list">{{ lastCodes.join('\n') }}</div>
    </el-alert>

    <div class="section-title">发码批次</div>
    <el-table :data="batches" v-loading="loadingList" size="small">
      <el-table-column prop="code" label="批次号" width="210" />
      <el-table-column prop="quantity" label="数量" width="90" />
      <el-table-column prop="issued_count" label="已发" width="90" />
      <el-table-column prop="failed_count" label="失败" width="90" />
      <el-table-column prop="status" label="状态" width="150">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'completed' ? 'success' : 'warning'">
            {{ row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="备注" />
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errMsg, idemKey } from '../api';
import { useAuth } from '../store';

const auth = useAuth();

interface Product {
  id: string;
  code: string;
  name: string;
}

interface Policy {
  id: string;
  product_id: string;
  code: string;
  name: string;
  kind: string;
  duration_days: number | null;
  device_limit: number;
  seat_limit: number | null;
  features: string[];
  offline_window_days: number;
}

interface Channel {
  id: string;
  code: string;
  name: string;
}

const loading = ref(false);
const loadingList = ref(false);
const quantity = ref(10);
const note = ref('');
const productId = ref('');
const policyId = ref('');
const channelId = ref('');
const lastCodes = ref<string[]>([]);
const batches = ref<Record<string, unknown>[]>([]);
const catalog = reactive<{ products: Product[]; policies: Policy[]; channels: Channel[] }>({
  products: [],
  policies: [],
  channels: [],
});

const productPolicies = computed(() =>
  catalog.policies.filter((p) => p.product_id === productId.value),
);
const selectedPolicy = computed(() => catalog.policies.find((p) => p.id === policyId.value));

function productChanged(): void {
  policyId.value = productPolicies.value[0]?.id ?? '';
}

async function loadCatalog(): Promise<void> {
  try {
    const { data } = await api.get('/admin/v1/catalog');
    catalog.products = data.data.products;
    catalog.policies = data.data.policies;
    catalog.channels = data.data.channels;
    if (!productId.value && catalog.products[0]) {
      productId.value = catalog.products[0].id;
      productChanged();
    }
    if (!channelId.value && catalog.channels[0]) channelId.value = catalog.channels[0].id;
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

async function loadBatches(): Promise<void> {
  loadingList.value = true;
  try {
    const { data } = await api.get('/admin/v1/batches', { params: { limit: 50 } });
    batches.value = data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loadingList.value = false;
  }
}

async function loadAll(): Promise<void> {
  await Promise.all([loadCatalog(), loadBatches()]);
}

async function issue(): Promise<void> {
  loading.value = true;
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
      { headers: { 'Idempotency-Key': idemKey() } },
    );
    lastCodes.value = (data.data.codes ?? []) as string[];
    ElMessage.success(`已发 ${data.data.issued_count} 个码`);
    await loadBatches();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function copyCodes(): Promise<void> {
  await navigator.clipboard.writeText(lastCodes.value.join('\n'));
  ElMessage.success('授权码已复制');
}

onMounted(loadAll);
</script>

<style scoped>
.page-card { border-radius: 8px; }
.page-head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
.page-head h2 { margin: 0; font-size: 20px; color: #1f2937; }
.page-head p { margin: 6px 0 0; color: #6b7280; font-size: 13px; }
.notice { margin-bottom: 16px; }
.issue-form { display: grid; grid-template-columns: 1.2fr 1.4fr 1fr 130px 1.4fr auto; gap: 0 14px; align-items: end; }
.policy-summary { display: flex; gap: 18px; flex-wrap: wrap; padding: 10px 12px; background: #f7f9fa; border-left: 3px solid #167d7f; color: #4b5563; font-size: 13px; }
.codes { margin-top: 16px; }
.codes-title { display: flex; justify-content: space-between; }
.code-list { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; max-height: 180px; overflow: auto; line-height: 1.7; }
.section-title { margin: 22px 0 10px; font-size: 15px; font-weight: 600; color: #374151; }
@media (max-width: 1100px) {
  .issue-form { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 700px) {
  .issue-form { grid-template-columns: 1fr; }
  .page-head { flex-direction: column; }
}
</style>
