<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>{{ t('catalog.title') }}</h2>
          <p>{{ t('catalog.subtitle') }}</p>
        </div>
        <el-button :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
      </div>
    </template>

    <el-tabs v-model="tab">
      <el-tab-pane :label="t('catalog.tabProducts')" name="products">
        <div class="toolbar">
          <span>{{ t('catalog.countProducts', { n: catalog.products.length }) }}</span>
          <el-button v-if="auth.can('product:write')" type="primary" @click="productDialog = true">
            {{ t('catalog.newProduct') }}
          </el-button>
        </div>
        <el-table :data="catalog.products" size="small">
          <el-table-column prop="code" :label="t('catalog.colProductCode')" min-width="180" />
          <el-table-column prop="name" :label="t('catalog.colProductName')" min-width="220" />
          <el-table-column prop="status" :label="t('catalog.colStatus')" width="110" />
          <el-table-column prop="id" :label="t('catalog.colProductId')" min-width="280" />
          <el-table-column :label="t('common.actions')" width="90">
            <template #default="{ row }">
              <el-button v-if="auth.can('product:write')" link type="primary" @click="openEditProduct(row)">
                {{ t('common.edit') }}
              </el-button>
              <el-button v-if="auth.can('product:write')" link type="danger" @click="removeProduct(row)">
                {{ t('common.delete') }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane :label="t('catalog.tabPolicies')" name="policies">
        <div class="toolbar">
          <span>{{ t('catalog.countPolicies', { n: catalog.policies.length }) }}</span>
          <el-button
            v-if="auth.can('policy:write')"
            type="primary"
            :disabled="!catalog.products.length"
            @click="policyDialog = true"
          >
            {{ t('catalog.newPolicy') }}
          </el-button>
        </div>
        <el-table :data="catalog.policies" size="small">
          <el-table-column prop="name" :label="t('catalog.colPolicyName')" min-width="180" />
          <el-table-column prop="product_name" :label="t('catalog.colProduct')" min-width="160" />
          <el-table-column prop="kind" :label="t('catalog.colKind')" width="110" />
          <el-table-column :label="t('catalog.colValidity')" width="100">
            <template #default="{ row }">{{ row.duration_days ? t('catalog.days', { n: row.duration_days }) : t('catalog.perpetual') }}</template>
          </el-table-column>
          <el-table-column prop="device_limit" :label="t('catalog.colDevices')" width="90" />
          <el-table-column prop="seat_limit" :label="t('catalog.colSeats')" width="80">
            <template #default="{ row }">{{ row.seat_limit ?? '-' }}</template>
          </el-table-column>
          <el-table-column :label="t('catalog.colFeatures')" min-width="180">
            <template #default="{ row }">{{ row.features.join(', ') }}</template>
          </el-table-column>
          <el-table-column prop="status" :label="t('catalog.colStatus')" width="100" />
          <el-table-column :label="t('common.actions')" width="90">
            <template #default="{ row }">
              <el-button v-if="auth.can('policy:write')" link type="primary" @click="openEditPolicy(row)">
                {{ t('common.edit') }}
              </el-button>
              <el-button v-if="auth.can('policy:write')" link type="danger" @click="removePolicy(row)">
                {{ t('common.delete') }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane :label="t('catalog.tabChannels')" name="channels">
        <div class="toolbar">
          <span>{{ t('catalog.countChannels', { n: catalog.channels.length }) }}</span>
          <el-button v-if="auth.can('channel:write')" type="primary" @click="channelDialog = true">
            {{ t('catalog.newChannel') }}
          </el-button>
        </div>
        <el-table :data="catalog.channels" size="small">
          <el-table-column prop="code" :label="t('catalog.colChannelCode')" min-width="180" />
          <el-table-column prop="name" :label="t('catalog.colChannelName')" min-width="220" />
          <el-table-column prop="status" :label="t('catalog.colStatus')" width="110" />
          <el-table-column prop="id" :label="t('catalog.colChannelId')" min-width="280" />
          <el-table-column :label="t('common.actions')" width="90">
            <template #default="{ row }">
              <el-button v-if="auth.can('channel:write')" link type="primary" @click="openEditChannel(row)">
                {{ t('common.edit') }}
              </el-button>
              <el-button v-if="auth.can('channel:write')" link type="danger" @click="removeChannel(row)">
                {{ t('common.delete') }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </el-card>

  <el-dialog v-model="productDialog" :title="t('catalog.newProduct')" width="480px">
    <el-form label-width="92px">
      <el-form-item :label="t('catalog.colProductCode')">
        <el-input v-model="productForm.code" :placeholder="t('catalog.codePlaceholder')" />
      </el-form-item>
      <el-form-item :label="t('catalog.colProductName')">
        <el-input v-model="productForm.name" :placeholder="t('catalog.namePlaceholder')" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="productDialog = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="createProduct">{{ t('common.create') }}</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="channelDialog" :title="t('catalog.newChannel')" width="480px">
    <el-form label-width="92px">
      <el-form-item :label="t('catalog.colChannelCode')">
        <el-input v-model="channelForm.code" :placeholder="t('catalog.channelCodePlaceholder')" />
      </el-form-item>
      <el-form-item :label="t('catalog.colChannelName')">
        <el-input v-model="channelForm.name" :placeholder="t('catalog.channelNamePlaceholder')" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="channelDialog = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="createChannel">{{ t('common.create') }}</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="policyDialog" :title="t('catalog.createPolicyTitle')" width="720px">
    <el-form label-width="120px" class="policy-form">
      <el-form-item :label="t('catalog.colProduct')">
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
        <el-form-item :label="t('catalog.fieldCode')">
          <el-input v-model="policyForm.code" placeholder="standard-365" />
        </el-form-item>
        <el-form-item :label="t('catalog.fieldName')">
          <el-input v-model="policyForm.name" :placeholder="t('catalog.policyNamePlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('catalog.fieldKind')">
          <el-select v-model="policyForm.kind" style="width: 100%" @change="kindChanged">
            <el-option :label="t('catalog.kind.standard')" value="standard" />
            <el-option :label="t('catalog.kind.trial')" value="trial" />
            <el-option :label="t('catalog.kind.perpetual')" value="perpetual" />
            <el-option :label="t('catalog.kind.subscription')" value="subscription" />
            <el-option :label="t('catalog.kind.floating')" value="floating" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('catalog.fieldDuration')">
          <el-input-number
            v-model="policyForm.duration_days"
            :min="1"
            :max="36500"
            :disabled="policyForm.kind === 'perpetual'"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item :label="t('catalog.fieldDeviceLimit')">
          <el-input-number v-model="policyForm.device_limit" :min="1" :max="100000" style="width: 100%" />
        </el-form-item>
        <el-form-item :label="t('catalog.fieldSeatLimit')">
          <el-input-number v-model="policyForm.seat_limit" :min="1" :max="1000000" style="width: 100%" />
        </el-form-item>
        <el-form-item :label="t('catalog.fieldConcurrency')">
          <el-input-number v-model="policyForm.concurrency_limit" :min="1" :max="1000000" style="width: 100%" />
        </el-form-item>
        <el-form-item :label="t('catalog.fieldOffline')">
          <el-input-number v-model="policyForm.offline_window_days" :min="0" :max="90" style="width: 100%" />
        </el-form-item>
        <el-form-item :label="t('catalog.fieldHeartbeat')">
          <el-input-number v-model="policyForm.heartbeat_hours" :min="1" :max="168" style="width: 100%" />
        </el-form-item>
        <el-form-item :label="t('catalog.fieldRenewWindow')">
          <el-input-number v-model="policyForm.renew_window_days" :min="0" :max="3650" style="width: 100%" />
        </el-form-item>
      </div>
      <el-form-item :label="t('catalog.fieldFeatures')">
        <el-input v-model="policyForm.featuresText" :placeholder="t('catalog.featuresPlaceholder')" />
      </el-form-item>
      <div class="form-grid">
        <el-form-item :label="t('catalog.allowRenewal')">
          <el-switch v-model="policyForm.allow_renewal" :disabled="policyForm.kind === 'trial'" />
        </el-form-item>
        <el-form-item :label="t('catalog.minVersion')">
          <el-input v-model="policyForm.min_version" :placeholder="t('catalog.minVersionPlaceholder')" />
        </el-form-item>
      </div>
    </el-form>
    <template #footer>
      <el-button @click="policyDialog = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="createPolicy">{{ t('catalog.createPolicy') }}</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="editProductDialog" :title="t('catalog.editProductTitle')" width="460px">
    <el-form label-width="92px">
      <el-form-item :label="t('catalog.colProductCode')">
        <el-input :model-value="editProduct?.code" disabled />
      </el-form-item>
      <el-form-item :label="t('catalog.colProductName')">
        <el-input v-model="editProductForm.name" />
      </el-form-item>
      <el-form-item :label="t('catalog.colStatus')">
        <el-switch
          v-model="editProductForm.active"
          :active-text="t('catalog.enabled')"
          :inactive-text="t('catalog.inactive')"
        />
      </el-form-item>
      <p class="tip">{{ t('catalog.productDisableTip') }}</p>
    </el-form>
    <template #footer>
      <el-button @click="editProductDialog = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="saveProduct">{{ t('common.save') }}</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="editChannelDialog" :title="t('catalog.editChannelTitle')" width="460px">
    <el-form label-width="92px">
      <el-form-item :label="t('catalog.colChannelCode')">
        <el-input :model-value="editChannel?.code" disabled />
      </el-form-item>
      <el-form-item :label="t('catalog.colChannelName')">
        <el-input v-model="editChannelForm.name" />
      </el-form-item>
      <el-form-item :label="t('catalog.colStatus')">
        <el-switch v-model="editChannelForm.active" :active-text="t('catalog.enabled')" :inactive-text="t('catalog.inactive')" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="editChannelDialog = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="saveChannel">{{ t('common.save') }}</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="editPolicyDialog" :title="t('catalog.editPolicyTitle')" width="560px">
    <el-form label-width="110px">
      <el-form-item :label="t('catalog.fieldName')">
        <el-input v-model="editPolicyForm.name" />
      </el-form-item>
      <el-form-item :label="t('catalog.colStatus')">
        <el-switch v-model="editPolicyForm.active" :active-text="t('catalog.enabled')" :inactive-text="t('catalog.inactive')" />
      </el-form-item>
      <div class="form-grid">
        <el-form-item :label="t('catalog.fieldDuration')">
          <el-input-number v-model="editPolicyForm.duration_days" :min="1" :max="36500" style="width: 100%" />
        </el-form-item>
        <el-form-item :label="t('catalog.deviceLimitShort')">
          <el-input-number v-model="editPolicyForm.device_limit" :min="1" :max="100000" style="width: 100%" />
        </el-form-item>
        <el-form-item :label="t('catalog.seatLimitShort')">
          <el-input-number v-model="editPolicyForm.seat_limit" :min="1" :max="1000000" :value-on-clear="null" style="width: 100%" />
        </el-form-item>
        <el-form-item :label="t('catalog.concurrencyShort')">
          <el-input-number v-model="editPolicyForm.concurrency_limit" :min="1" :max="1000000" :value-on-clear="null" style="width: 100%" />
        </el-form-item>
        <el-form-item :label="t('catalog.fieldOffline')">
          <el-input-number v-model="editPolicyForm.offline_window_days" :min="0" :max="90" style="width: 100%" />
        </el-form-item>
        <el-form-item :label="t('catalog.fieldHeartbeat')">
          <el-input-number v-model="editPolicyForm.heartbeat_hours" :min="1" :max="168" style="width: 100%" />
        </el-form-item>
      </div>
      <el-form-item :label="t('catalog.fieldFeatures')">
        <el-input v-model="editPolicyForm.featuresText" placeholder="dorm,leave" />
      </el-form-item>
      <el-form-item :label="t('catalog.allowRenewal')">
        <el-switch v-model="editPolicyForm.allow_renewal" />
      </el-form-item>
      <p class="tip">{{ t('catalog.policyEditTip') }}</p>
    </el-form>
    <template #footer>
      <el-button @click="editPolicyDialog = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="savePolicy">{{ t('common.save') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';
import { useI18n } from 'vue-i18n';

const auth = useAuth();
const { t } = useI18n();

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

// 只有渠道权限的角色(运营/渠道)默认落在渠道页, 而不是空白的产品页
const tab = ref(
  auth.can('product:write') || auth.can('policy:write') ? 'policies' : 'channels',
);
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
    ElMessage.success(t('catalog.createdProduct'));
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
    ElMessage.success(t('catalog.createdChannel'));
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
    ElMessage.success(t('catalog.createdPolicy'));
    policyDialog.value = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

// ---- 编辑: 产品 / 渠道 / 策略 ----
const editProductDialog = ref(false);
const editChannelDialog = ref(false);
const editPolicyDialog = ref(false);
const editProduct = ref<Product | null>(null);
const editChannel = ref<Channel | null>(null);
const editPolicy = ref<Policy | null>(null);

const editProductForm = reactive({ name: '', active: true });
const editChannelForm = reactive({ name: '', active: true });
const editPolicyForm = reactive({
  name: '',
  active: true,
  duration_days: 365 as number | null,
  device_limit: 5,
  seat_limit: null as number | null,
  concurrency_limit: null as number | null,
  offline_window_days: 7,
  heartbeat_hours: 24,
  allow_renewal: true,
  featuresText: '',
});

function openEditProduct(row: Product): void {
  editProduct.value = row;
  editProductForm.name = row.name;
  editProductForm.active = row.status === 'active';
  editProductDialog.value = true;
}

async function saveProduct(): Promise<void> {
  if (!editProduct.value) return;
  saving.value = true;
  try {
    await api.patch(`/admin/v1/catalog/products/${editProduct.value.id}`, {
      name: editProductForm.name,
      status: editProductForm.active ? 'active' : 'disabled',
    });
    ElMessage.success(t('catalog.updatedProduct'));
    editProductDialog.value = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

function openEditChannel(row: Channel): void {
  editChannel.value = row;
  editChannelForm.name = row.name;
  editChannelForm.active = row.status === 'active';
  editChannelDialog.value = true;
}

async function saveChannel(): Promise<void> {
  if (!editChannel.value) return;
  saving.value = true;
  try {
    await api.patch(`/admin/v1/catalog/channels/${editChannel.value.id}`, {
      name: editChannelForm.name,
      status: editChannelForm.active ? 'active' : 'disabled',
    });
    ElMessage.success(t('catalog.updatedChannel'));
    editChannelDialog.value = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

function openEditPolicy(row: Policy): void {
  editPolicy.value = row;
  editPolicyForm.name = row.name;
  editPolicyForm.active = row.status === 'active';
  editPolicyForm.duration_days = row.duration_days;
  editPolicyForm.device_limit = row.device_limit;
  editPolicyForm.seat_limit = row.seat_limit;
  editPolicyForm.concurrency_limit = row.concurrency_limit;
  editPolicyForm.offline_window_days = row.offline_window_days;
  editPolicyForm.heartbeat_hours = row.heartbeat_hours;
  editPolicyForm.allow_renewal = row.allow_renewal;
  editPolicyForm.featuresText = row.features.join(',');
  editPolicyDialog.value = true;
}

async function savePolicy(): Promise<void> {
  if (!editPolicy.value) return;
  const features = editPolicyForm.featuresText
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  saving.value = true;
  try {
    await api.patch(`/admin/v1/catalog/policies/${editPolicy.value.id}`, {
      name: editPolicyForm.name,
      status: editPolicyForm.active ? 'active' : 'disabled',
      duration_days: editPolicyForm.duration_days,
      device_limit: editPolicyForm.device_limit,
      seat_limit: editPolicyForm.seat_limit,
      concurrency_limit: editPolicyForm.concurrency_limit,
      offline_window_days: editPolicyForm.offline_window_days,
      heartbeat_hours: editPolicyForm.heartbeat_hours,
      allow_renewal: editPolicyForm.allow_renewal,
      features,
    });
    ElMessage.success(t('catalog.updatedPolicy'));
    editPolicyDialog.value = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

async function remove(kind: 'products' | 'policies' | 'channels', row: { name: string; id: string }): Promise<void> {
  try {
    await ElMessageBox.confirm(
      t('catalog.deleteConfirm', { name: row.name }),
      t('catalog.deleteTitle'),
      { type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await api.delete(`/admin/v1/catalog/${kind}/${row.id}`);
    ElMessage.success(t('catalog.deleted'));
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}
const removeProduct = (row: Product) => remove('products', row);
const removePolicy = (row: Policy) => remove('policies', row);
const removeChannel = (row: Channel) => remove('channels', row);

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
.tip {
  color: #909399;
  font-size: 12px;
  margin: 4px 0 0 92px;
}
</style>
