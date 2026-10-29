<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>{{ t('batches.title') }}</h2>
          <p>{{ t('batches.subtitle') }}</p>
        </div>
        <el-button :loading="loadingList" @click="loadAll">{{ t('common.refresh') }}</el-button>
      </div>
    </template>

    <el-alert
      v-if="!catalog.products.length || !catalog.policies.length"
      type="warning"
      show-icon
      :closable="false"
      :title="t('batches.noticeNeedCatalog')"
      class="notice"
    />

    <el-form v-if="auth.can('license:issue')" label-position="top" class="issue-form">
      <el-form-item :label="t('batches.fieldProduct')">
        <el-select v-model="productId" :placeholder="t('batches.productPlaceholder')" style="width: 100%" @change="productChanged">
          <el-option
            v-for="p in catalog.products"
            :key="p.id"
            :label="`${p.name} (${p.code})`"
            :value="p.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('batches.fieldPolicy')">
        <el-select v-model="policyId" :placeholder="t('batches.policyPlaceholder')" style="width: 100%">
          <el-option
            v-for="p in productPolicies"
            :key="p.id"
            :label="`${p.name} · ${p.kind} · ${p.duration_days ?? t('batches.perpetual')}`"
            :value="p.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('batches.fieldChannel')">
        <el-select v-model="channelId" :clearable="true" :placeholder="t('batches.channelPlaceholder')" style="width: 100%">
          <el-option
            v-for="c in catalog.channels"
            :key="c.id"
            :label="`${c.name} (${c.code})`"
            :value="c.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('batches.fieldQuantity')">
        <el-input-number v-model="quantity" :min="1" :max="100000" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('batches.fieldNote')" class="note-field">
        <el-input v-model="note" :placeholder="t('batches.notePlaceholder')" />
      </el-form-item>
      <el-form-item label=" ">
        <el-button
          type="primary"
          :loading="loading"
          :disabled="!productId || !policyId"
          @click="issue"
        >
          {{ t('batches.issue') }}
        </el-button>
      </el-form-item>
    </el-form>

    <div v-if="selectedPolicy" class="policy-summary">
      <span>{{ t('batches.deviceCount', { n: selectedPolicy.device_limit }) }}</span>
      <span>{{ t('batches.seatCount', { n: selectedPolicy.seat_limit ?? t('common.none') }) }}</span>
      <span>{{ t('batches.offlineDays', { n: selectedPolicy.offline_window_days }) }}</span>
      <span>{{ t('batches.features', { list: selectedPolicy.features.join(' / ') }) }}</span>
    </div>

    <el-alert v-if="lastCodes.length" type="success" :closable="false" class="codes">
      <template #title>
        <div class="codes-title">
          <span>{{ t('batches.codesTitle', { n: lastCodes.length }) }}</span>
          <el-button link type="primary" @click="copyCodes">{{ t('batches.copyAll') }}</el-button>
        </div>
      </template>
      <div class="code-list">{{ lastCodes.join('\n') }}</div>
    </el-alert>

    <div class="section-title">{{ t('batches.sectionTitle') }}</div>
    <el-table :data="batches" v-loading="loadingList" size="small">
      <el-table-column prop="code" :label="t('batches.colBatchCode')" width="210" />
      <el-table-column prop="quantity" :label="t('batches.colQuantity')" width="90" />
      <el-table-column prop="issued_count" :label="t('batches.colIssued')" width="90" />
      <el-table-column prop="failed_count" :label="t('batches.colFailed')" width="90" />
      <el-table-column prop="status" :label="t('batches.colStatus')" width="150">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'completed' ? 'success' : 'warning'">
            {{ row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="note" :label="t('batches.colNote')" />
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errMsg, idemKey } from '../api';
import { useAuth } from '../store';
import { useI18n } from 'vue-i18n';

const auth = useAuth();
const { t } = useI18n();

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
    ElMessage.success(t('batches.issuedOk', { n: data.data.issued_count }));
    await loadBatches();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function copyCodes(): Promise<void> {
  await navigator.clipboard.writeText(lastCodes.value.join('\n'));
  ElMessage.success(t('batches.copied'));
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
