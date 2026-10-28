<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>产品与授权策略</h2>
          <p>产品决定授权码前缀，策略决定有效期、设备数、席位与功能权益。</p>
        </div>
        <el-button :loading="loading" @click="load">刷新</el-button>
      </div>
    </template>

    <el-tabs v-model="tab">
      <el-tab-pane label="产品" name="products">
        <div class="toolbar">
          <span>共 {{ catalog.products.length }} 个产品</span>
          <el-button v-if="auth.can('product:write')" type="primary" @click="productDialog = true">
            新建产品
          </el-button>
        </div>
        <el-table :data="catalog.products" size="small">
          <el-table-column prop="code" label="产品编码" min-width="180" />
          <el-table-column prop="name" label="产品名称" min-width="220" />
          <el-table-column prop="status" label="状态" width="110" />
          <el-table-column prop="id" label="产品 ID" min-width="280" />
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="授权策略" name="policies">
        <div class="toolbar">
          <span>共 {{ catalog.policies.length }} 个策略</span>
          <el-button
            v-if="auth.can('policy:write')"
            type="primary"
            :disabled="!catalog.products.length"
            @click="policyDialog = true"
          >
            新建策略
          </el-button>
        </div>
        <el-table :data="catalog.policies" size="small">
          <el-table-column prop="name" label="策略名称" min-width="180" />
          <el-table-column prop="product_name" label="产品" min-width="160" />
          <el-table-column prop="kind" label="类型" width="110" />
          <el-table-column label="有效期" width="100">
            <template #default="{ row }">{{ row.duration_days ? `${row.duration_days} 天` : '永久' }}</template>
          </el-table-column>
          <el-table-column prop="device_limit" label="设备数" width="90" />
          <el-table-column prop="seat_limit" label="席位" width="80">
            <template #default="{ row }">{{ row.seat_limit ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="功能" min-width="180">
            <template #default="{ row }">{{ row.features.join(', ') }}</template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="100" />
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="渠道" name="channels">
        <div class="toolbar">
          <span>共 {{ catalog.channels.length }} 个渠道</span>
          <el-button v-if="auth.can('channel:write')" type="primary" @click="channelDialog = true">
            新建渠道
          </el-button>
        </div>
        <el-table :data="catalog.channels" size="small">
          <el-table-column prop="code" label="渠道编码" min-width="180" />
          <el-table-column prop="name" label="渠道名称" min-width="220" />
          <el-table-column prop="status" label="状态" width="110" />
          <el-table-column prop="id" label="渠道 ID" min-width="280" />
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </el-card>

  <el-dialog v-model="productDialog" title="新建产品" width="480px">
    <el-form label-width="92px">
      <el-form-item label="产品编码">
        <el-input v-model="productForm.code" placeholder="如 school-dorm" />
      </el-form-item>
      <el-form-item label="产品名称">
        <el-input v-model="productForm.name" placeholder="如 校园宿舍管理系统" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="productDialog = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="createProduct">创建</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="channelDialog" title="新建渠道" width="480px">
    <el-form label-width="92px">
      <el-form-item label="渠道编码">
        <el-input v-model="channelForm.code" placeholder="如 east-partner" />
      </el-form-item>
      <el-form-item label="渠道名称">
        <el-input v-model="channelForm.name" placeholder="如 华东代理商" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="channelDialog = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="createChannel">创建</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="policyDialog" title="新建授权策略" width="720px">
    <el-form label-width="120px" class="policy-form">
      <el-form-item label="产品">
        <el-select v-model="policyForm.product_id" style="width: 100%">
          <el-option
            v-for="p in catalog.products"
            :key="p.id"
            :label="`${p.name} (${p.code})`"
            :value="p.id"
          />
        </el-select>
      </el-form-item>
      <div class="form-grid">
        <el-form-item label="策略编码">
          <el-input v-model="policyForm.code" placeholder="standard-365" />
        </el-form-item>
        <el-form-item label="策略名称">
          <el-input v-model="policyForm.name" placeholder="标准版 365 天" />
        </el-form-item>
        <el-form-item label="授权类型">
          <el-select v-model="policyForm.kind" style="width: 100%" @change="kindChanged">
            <el-option label="标准" value="standard" />
            <el-option label="试用" value="trial" />
            <el-option label="永久" value="perpetual" />
            <el-option label="订阅" value="subscription" />
            <el-option label="浮动" value="floating" />
          </el-select>
        </el-form-item>
        <el-form-item label="有效期(天)">
          <el-input-number
            v-model="policyForm.duration_days"
            :min="1"
            :max="36500"
            :disabled="policyForm.kind === 'perpetual'"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="设备数上限">
          <el-input-number v-model="policyForm.device_limit" :min="1" :max="100000" style="width: 100%" />
        </el-form-item>
        <el-form-item label="席位上限">
          <el-input-number v-model="policyForm.seat_limit" :min="1" :max="1000000" style="width: 100%" />
        </el-form-item>
        <el-form-item label="并发上限">
          <el-input-number v-model="policyForm.concurrency_limit" :min="1" :max="1000000" style="width: 100%" />
        </el-form-item>
        <el-form-item label="离线窗口(天)">
          <el-input-number v-model="policyForm.offline_window_days" :min="0" :max="90" style="width: 100%" />
        </el-form-item>
        <el-form-item label="心跳间隔(小时)">
          <el-input-number v-model="policyForm.heartbeat_hours" :min="1" :max="168" style="width: 100%" />
        </el-form-item>
        <el-form-item label="续期窗口(天)">
          <el-input-number v-model="policyForm.renew_window_days" :min="0" :max="3650" style="width: 100%" />
        </el-form-item>
      </div>
      <el-form-item label="功能权益">
        <el-input v-model="policyForm.featuresText" placeholder="dorm,leave,report (逗号分隔)" />
      </el-form-item>
      <div class="form-grid">
        <el-form-item label="允许续期">
          <el-switch v-model="policyForm.allow_renewal" :disabled="policyForm.kind === 'trial'" />
        </el-form-item>
        <el-form-item label="最低客户端版本">
          <el-input v-model="policyForm.min_version" placeholder=">=2.0.0，可留空" />
        </el-form-item>
      </div>
    </el-form>
    <template #footer>
      <el-button @click="policyDialog = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="createPolicy">创建策略</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';

const auth = useAuth();

interface Product {
  id: string;
  code: string;
  name: string;
  status: string;
}

interface Policy {
  id: string;
  product_id: string;
  product_code: string;
  product_name: string;
  code: string;
  name: string;
  kind: string;
  duration_days: number | null;
  device_limit: number;
  seat_limit: number | null;
  concurrency_limit: number | null;
  features: string[];
  offline_window_days: number;
  heartbeat_hours: number;
  grace_hours: number;
  activate_within_days: number;
  allow_renewal: boolean;
  renew_window_days: number;
  min_version: string | null;
  status: string;
}

interface Channel {
  id: string;
  code: string;
  name: string;
  status: string;
}

const tab = ref('policies');
const loading = ref(false);
const saving = ref(false);
const productDialog = ref(false);
const channelDialog = ref(false);
const policyDialog = ref(false);
const catalog = reactive<{ products: Product[]; policies: Policy[]; channels: Channel[] }>({
  products: [],
  policies: [],
  channels: [],
});

const productForm = reactive({ code: '', name: '' });
const channelForm = reactive({ code: '', name: '' });
const policyForm = reactive({
  product_id: '',
  code: '',
  name: '',
  kind: 'standard',
  duration_days: 365,
  device_limit: 5,
  seat_limit: null as number | null,
  concurrency_limit: null as number | null,
  featuresText: 'dorm',
  offline_window_days: 7,
  heartbeat_hours: 24,
  grace_hours: 72,
  activate_within_days: 0,
  allow_renewal: true,
  renew_window_days: 90,
  min_version: null as string | null,
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.get('/admin/v1/catalog');
    catalog.products = data.data.products;
    catalog.policies = data.data.policies;
    catalog.channels = data.data.channels;
    if (!policyForm.product_id && catalog.products[0]) policyForm.product_id = catalog.products[0].id;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function createProduct(): Promise<void> {
  saving.value = true;
  try {
    await api.post('/admin/v1/catalog/products', productForm);
    ElMessage.success('产品已创建');
    productDialog.value = false;
    productForm.code = '';
    productForm.name = '';
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

async function createChannel(): Promise<void> {
  saving.value = true;
  try {
    await api.post('/admin/v1/catalog/channels', channelForm);
    ElMessage.success('渠道已创建');
    channelDialog.value = false;
    channelForm.code = '';
    channelForm.name = '';
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

function kindChanged(kind: string): void {
  if (kind === 'perpetual') policyForm.duration_days = null as unknown as number;
  if (kind === 'trial') {
    policyForm.duration_days = 30;
    policyForm.device_limit = Math.min(policyForm.device_limit, 3);
    policyForm.allow_renewal = false;
  }
  if (kind === 'floating' && !policyForm.concurrency_limit) policyForm.concurrency_limit = 10;
}

async function createPolicy(): Promise<void> {
  saving.value = true;
  try {
    const features = policyForm.featuresText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    await api.post('/admin/v1/catalog/policies', {
      product_id: policyForm.product_id,
      code: policyForm.code,
      name: policyForm.name,
      kind: policyForm.kind,
      duration_days: policyForm.kind === 'perpetual' ? null : policyForm.duration_days,
      device_limit: policyForm.device_limit,
      seat_limit: policyForm.seat_limit,
      concurrency_limit: policyForm.concurrency_limit,
      features,
      offline_window_days: policyForm.offline_window_days,
      heartbeat_hours: policyForm.heartbeat_hours,
      grace_hours: policyForm.grace_hours,
      activate_within_days: policyForm.activate_within_days,
      allow_renewal: policyForm.allow_renewal,
      renew_window_days: policyForm.renew_window_days,
      min_version: policyForm.min_version || null,
    });
    ElMessage.success('策略已创建');
    policyDialog.value = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.page-card { border-radius: 8px; }
.page-head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
.page-head h2 { margin: 0; font-size: 20px; color: #1f2937; }
.page-head p { margin: 6px 0 0; color: #6b7280; font-size: 13px; }
.toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; color: #6b7280; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
.policy-form :deep(.el-input-number) { width: 100%; }
@media (max-width: 760px) {
  .form-grid { grid-template-columns: 1fr; }
  .page-head { flex-direction: column; }
}
</style>
