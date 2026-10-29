<template>
  <el-card class="page-card">
    <template #header>
      <div class="page-head">
        <div>
          <h2>{{ t('settings.title') }}</h2>
          <p>{{ t('settings.subtitle') }}</p>
        </div>
        <div class="actions">
          <el-button :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
        </div>
      </div>
    </template>

    <section class="block">
      <h3>{{ t('settings.sectionLocale') }}</h3>
      <p class="hint">{{ t('settings.localeHint') }}</p>
      <div class="row">
        <el-radio-group v-model="locale" :disabled="!auth.can('tenant:write')">
          <el-radio-button value="zh-CN">{{ t('settings.localeZh') }}</el-radio-button>
          <el-radio-button value="en">{{ t('settings.localeEn') }}</el-radio-button>
        </el-radio-group>
        <el-button
          v-if="auth.can('tenant:write')"
          type="primary"
          :loading="savingLocale"
          :disabled="locale === savedLocale"
          @click="saveLocale"
        >
          {{ t('common.save') }}
        </el-button>
      </div>
    </section>

    <el-divider />

    <section class="block">
      <h3>{{ t('settings.sectionTemplates') }}</h3>
      <p class="hint">{{ t('settings.templatesHint') }}</p>

      <div class="row">
        <el-select v-model="code" class="picker" @change="selectTemplate">
          <el-option v-for="c in codes" :key="c" :label="titleOf(c)" :value="c" />
        </el-select>
        <el-radio-group v-model="tmplLocale" @change="selectTemplate">
          <el-radio-button value="zh-CN">{{ t('settings.localeZh') }}</el-radio-button>
          <el-radio-button value="en">{{ t('settings.localeEn') }}</el-radio-button>
        </el-radio-group>
        <el-tag v-if="current" :type="current.source === 'tenant' ? 'warning' : 'info'" size="small">
          {{ current.source === 'tenant' ? t('settings.sourceTenant') : t('settings.sourceBuiltin') }}
        </el-tag>
        <el-button v-if="current" link type="primary" @click="preview">{{ t('settings.preview') }}</el-button>
      </div>

      <el-form label-width="90px" class="editor" :disabled="!auth.can('notify:write')">
        <el-form-item :label="t('settings.subject')">
          <el-input v-model="form.subject" maxlength="200" show-word-limit />
        </el-form-item>
        <el-form-item :label="t('settings.body')">
          <el-input v-model="form.body" type="textarea" :rows="11" />
        </el-form-item>
        <el-form-item :label="t('settings.sms')">
          <el-input v-model="form.sms" type="textarea" :rows="2" maxlength="500" show-word-limit />
        </el-form-item>
        <el-form-item :label="t('settings.vars')">
          <div class="vars">
            <el-tag
              v-for="v in current?.vars ?? []"
              :key="v.name"
              size="small"
              class="var"
              @click="insertVar(v.name)"
            >
              {{ wrapVar(v.name) }}
            </el-tag>
          </div>
        </el-form-item>
      </el-form>

      <div v-if="auth.can('notify:write')" class="actions">
        <el-button :loading="savingTemplate" type="primary" @click="saveTemplate">
          {{ t('settings.saveTemplate') }}
        </el-button>
        <el-button :disabled="current?.source !== 'tenant'" @click="resetTemplate">
          {{ t('settings.resetTemplate') }}
        </el-button>
      </div>

      <el-card v-if="rendered" class="preview" shadow="never">
        <div class="preview-head">{{ t('settings.previewTitle') }}</div>
        <div class="preview-subject">{{ rendered.subject }}</div>
        <pre class="preview-body">{{ rendered.text }}</pre>
        <div v-if="rendered.sms" class="preview-sms">SMS: {{ rendered.sms }}</div>
      </el-card>
    </section>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';
import { useI18n } from 'vue-i18n';

const auth = useAuth();
const { t } = useI18n();

interface TemplateView {
  code: string;
  title: string;
  locale: 'zh-CN' | 'en';
  vars: { name: string; sample: string }[];
  subject: string;
  body: string;
  sms_body: string | null;
  source: 'tenant' | 'builtin';
}

interface Rendered {
  subject: string;
  text: string;
  sms?: string;
}

const loading = ref(false);
const savingLocale = ref(false);
const savingTemplate = ref(false);
const locale = ref<'zh-CN' | 'en'>('zh-CN');
const savedLocale = ref<'zh-CN' | 'en'>('zh-CN');
const all = ref<TemplateView[]>([]);
const code = ref<string>('');
const tmplLocale = ref<'zh-CN' | 'en'>('zh-CN');
const rendered = ref<Rendered | null>(null);
const form = reactive({ subject: '', body: '', sms: '' });

const codes = computed(() => [...new Set(all.value.map((x) => x.code))]);
const current = computed(() =>
  all.value.find((x) => x.code === code.value && x.locale === tmplLocale.value),
);

function titleOf(c: string): string {
  return all.value.find((x) => x.code === c)?.title ?? c;
}

function selectTemplate(): void {
  const c = current.value;
  if (!c) return;
  form.subject = c.subject;
  form.body = c.body;
  form.sms = c.sms_body ?? '';
  rendered.value = null;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [tenant, templates] = await Promise.all([
      api.get('/admin/v1/tenant'),
      api.get('/admin/v1/notify-templates'),
    ]);
    locale.value = tenant.data.data.locale;
    savedLocale.value = tenant.data.data.locale;
    all.value = templates.data.data;
    if (!code.value) code.value = codes.value[0] ?? '';
    selectTemplate();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function saveLocale(): Promise<void> {
  savingLocale.value = true;
  try {
    const { data } = await api.patch('/admin/v1/tenant', { locale: locale.value });
    savedLocale.value = data.data.locale;
    ElMessage.success(t('settings.saved'));
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    savingLocale.value = false;
  }
}

async function saveTemplate(): Promise<void> {
  savingTemplate.value = true;
  try {
    await api.put(`/admin/v1/notify-templates/${code.value}/${tmplLocale.value}`, {
      subject: form.subject,
      body: form.body,
      sms_body: form.sms.trim() ? form.sms : null,
    });
    ElMessage.success(t('settings.saved'));
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    savingTemplate.value = false;
  }
}

async function resetTemplate(): Promise<void> {
  try {
    await ElMessageBox.confirm(t('settings.resetConfirm'), t('settings.resetTemplate'), {
      type: 'warning',
    });
    await api.delete(`/admin/v1/notify-templates/${code.value}/${tmplLocale.value}`);
    rendered.value = null;
    await load();
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errMsg(e));
  }
}

async function preview(): Promise<void> {
  try {
    const { data } = await api.post(
      `/admin/v1/notify-templates/${code.value}/${tmplLocale.value}/preview`,
      {},
    );
    rendered.value = data.data;
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

/** 模板里插入的占位符: 用拼接而不是字面量, 避免被 Vue 当成插值解析 */
function wrapVar(name: string): string {
  return '{' + '{' + name + '}' + '}';
}

/** 点变量标签把占位符追加到正文末尾, 省得手打花括号 */
function insertVar(name: string): void {
  if (!auth.can('notify:write')) return;
  const sep = form.body && !form.body.endsWith('\n') ? ' ' : '';
  form.body = form.body + sep + wrapVar(name);
}

onMounted(load);
</script>

<style scoped>
.page-card { border-radius: 8px; }
.page-head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
.page-head h2 { margin: 0; font-size: 20px; color: #1f2937; }
.page-head p { margin: 6px 0 0; color: #6b7280; font-size: 13px; }
.block h3 { margin: 0 0 4px; font-size: 15px; color: #111827; }
.hint { margin: 0 0 12px; color: #6b7280; font-size: 13px; }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.picker { width: 320px; }
.editor { margin-top: 8px; }
.actions { display: flex; gap: 10px; margin-top: 4px; }
.vars { display: flex; gap: 8px; flex-wrap: wrap; }
.var { cursor: pointer; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.preview { margin-top: 16px; background: #fafafa; }
.preview-head { font-size: 12px; color: #6b7280; margin-bottom: 8px; }
.preview-subject { font-weight: 600; margin-bottom: 8px; }
.preview-body { white-space: pre-wrap; font-family: inherit; margin: 0; font-size: 13px; line-height: 1.6; }
.preview-sms { margin-top: 10px; font-size: 12px; color: #6b7280; }
</style>
