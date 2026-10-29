<template>
  <div class="register-wrap">
    <el-card class="register-card">
      <h2>{{ step === 1 ? t('register.title') : t('register.verifyTitle') }}</h2>

      <template v-if="step === 1">
        <p class="sub">{{ t('register.intro') }}</p>
        <el-form :model="form" label-width="0" @keyup.enter="submit">
          <el-form-item>
            <el-input v-model="form.developerName" :placeholder="t('register.devNamePlaceholder')" />
          </el-form-item>
          <el-form-item>
            <el-input v-model="form.email" :placeholder="t('register.emailPlaceholder')" />
          </el-form-item>
          <el-form-item>
            <el-input v-model="form.password" type="password" :placeholder="t('register.passwordPlaceholder')" show-password />
          </el-form-item>
          <el-form-item>
            <el-input v-model="form.confirm" type="password" :placeholder="t('register.confirmPlaceholder')" show-password />
          </el-form-item>
          <el-button type="primary" style="width: 100%" :loading="loading" @click="submit">
            {{ t('register.submit') }}
          </el-button>
        </el-form>
        <div class="foot">
          <span>{{ t('register.haveAccount') }}</span>
          <router-link to="/login">{{ t('register.backToLogin') }}</router-link>
        </div>
      </template>

      <template v-else>
        <p class="sub">{{ t('register.codeSent', { email: form.email }) }}</p>
        <el-alert v-if="devCode" :closable="false" type="info" class="dev-hint">
          {{ t('register.devCode') }}：<strong>{{ devCode }}</strong>
        </el-alert>
        <el-form label-width="0" @keyup.enter="verify">
          <el-form-item>
            <el-input v-model="code" maxlength="6" :placeholder="t('register.codePlaceholder')" />
          </el-form-item>
          <el-button type="primary" style="width: 100%" :loading="loading" @click="verify">
            {{ t('register.verifySubmit') }}
          </el-button>
        </el-form>
        <div class="foot">
          <el-button link type="primary" :disabled="cooldown > 0" @click="resend">
            {{ cooldown > 0 ? t('register.resendIn', { s: cooldown }) : t('register.resend') }}
          </el-button>
          <router-link to="/login">{{ t('register.backToLogin') }}</router-link>
        </div>
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';
import { landingPath } from '../router';

const router = useRouter();
const { t } = useI18n();
const auth = useAuth();
const loading = ref(false);
const step = ref<1 | 2>(1);
const code = ref('');
const devCode = ref('');
const cooldown = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

const form = reactive({ developerName: '', email: '', password: '', confirm: '' });

function startCooldown(): void {
  cooldown.value = 60;
  timer = setInterval(() => {
    cooldown.value -= 1;
    if (cooldown.value <= 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }, 1000);
}

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

async function submit(): Promise<void> {
  if (!form.developerName.trim()) return ElMessage.error(t('register.needDevName'));
  if (form.password.length < 8) return ElMessage.error(t('register.needPwdLen'));
  if (form.password !== form.confirm) return ElMessage.error(t('register.pwdMismatch'));

  loading.value = true;
  try {
    const { data } = await api.post('/admin/v1/auth/register', {
      email: form.email,
      password: form.password,
      developer_name: form.developerName,
    });
    devCode.value = data.data.dev_code ?? '';
    step.value = 2;
    startCooldown();
    ElMessage.success(t('register.registered'));
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function verify(): Promise<void> {
  if (!/^\d{6}$/.test(code.value)) return ElMessage.error(t('register.codeLen'));
  loading.value = true;
  try {
    const { data } = await api.post('/admin/v1/auth/verify-email', {
      email: form.email,
      code: code.value,
    });
    const d = data.data;
    auth.setLogin(d.access_token, d.refresh_token, d.user);
    ElMessage.success(t('register.verified'));
    void router.push(landingPath());
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function resend(): Promise<void> {
  if (cooldown.value > 0) return;
  try {
    const { data } = await api.post('/admin/v1/auth/resend-verification', { email: form.email });
    devCode.value = data.data.dev_code ?? '';
    startCooldown();
    ElMessage.success(t('register.resentCode'));
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}
</script>

<style scoped>
.register-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: #f2f3f5;
}
.register-card {
  width: 420px;
}
.sub {
  color: #909399;
  font-size: 12px;
  margin-bottom: 16px;
  line-height: 1.6;
}
.dev-hint {
  margin-bottom: 12px;
}
.foot {
  margin-top: 12px;
  text-align: center;
  font-size: 13px;
  color: #909399;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.foot a {
  color: var(--el-color-primary);
  text-decoration: none;
}
</style>
