<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>{{ t('customers.title') }}</h2>
          <p>{{ t('customers.subtitle') }}</p>
        </div>
        <el-button :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
      </div>
    </template>
    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="name" :label="t('customers.colName')" min-width="220" />
      <el-table-column prop="type" :label="t('customers.colType')" width="100" />
      <el-table-column :label="t('customers.colEmail')" width="130">
        <template #default="{ row }">
          <el-tag :type="row.has_email ? 'success' : 'warning'" size="small">
            {{ row.has_email ? t('customers.configured') : t('customers.notConfigured') }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="license_count" :label="t('customers.colLicenses')" width="90" />
      <el-table-column prop="status" :label="t('customers.colStatus')" width="100" />
      <el-table-column :label="t('common.actions')" width="140">
        <template #default="{ row }">
          <el-button v-if="auth.can('end_customer:write')" link type="primary" @click="edit(row)">
            {{ row.has_email ? t('customers.changeEmail') : t('customers.setEmail') }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-dialog v-model="dialog" :title="t('customers.dialogTitle')" width="460px">
    <el-form label-width="86px">
      <el-form-item :label="t('customers.fieldCustomer')">
        <span>{{ current?.name }}</span>
      </el-form-item>
      <el-form-item :label="t('customers.colEmail')">
        <el-input v-model="email" :placeholder="t('customers.emailPlaceholder')" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialog = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';
import { useI18n } from 'vue-i18n';

const auth = useAuth();
const { t } = useI18n();

interface Customer {
  id: string;
  name: string;
  type: string;
  has_email: boolean;
  status: string;
  license_count: number;
}

const rows = ref<Customer[]>([]);
const loading = ref(false);
const saving = ref(false);
const dialog = ref(false);
const current = ref<Customer | null>(null);
const email = ref('');

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.get('/admin/v1/end-customers');
    rows.value = data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

function edit(row: Customer): void {
  current.value = row;
  email.value = '';
  dialog.value = true;
}

async function save(): Promise<void> {
  if (!current.value) return;
  saving.value = true;
  try {
    await api.put(`/admin/v1/end-customers/${current.value.id}/contact-email`, {
      email: email.value.trim() || null,
    });
    ElMessage.success(t('customers.updated'));
    dialog.value = false;
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
</style>
