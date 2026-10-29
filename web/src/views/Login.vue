<template>
  <div class="login-wrap">
    <el-card class="login-card">
      <h2>{{ t('login.title') }}</h2>
      <el-form v-if="!challenge" :model="form" label-width="0" @keyup.enter="submit">
        <el-form-item>
          <el-input v-model="form.email" :placeholder="t('login.emailPlaceholder')" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.password" type="password" :placeholder="t('login.passwordPlaceholder')" show-password />
        </el-form-item>
        <el-alert v-if="unverified" :closable="false" type="warning" class="verify-hint">
          <div>{{ t('login.unverified') }}</div>
          <el-button link type="primary" @click="resend">{{ t('login.resend') }}</el-button>
          <router-link to="/register" class="to-register">{{ t('login.goVerify') }}</router-link>
        </el-alert>
        <el-button type="primary" style="width: 100%" :loading="loading" @click="submit">
          {{ t('login.submit') }}
        </el-button>
      </el-form>

      <el-form v-else label-width="0" @keyup.enter="verify">
        <p class="mfa-hint">{{ t('login.mfaHint') }}</p>
        <el-form-item>
          <el-input
            v-model="code"
            :placeholder="t('login.mfaCodePlaceholder')"
            autofocus
            maxlength="20"
          />
        </el-form-item>
        <el-button type="primary" style="width: 100%" :loading="loading" @click="verify">
          {{ t('login.mfaSubmit') }}
        </el-button>
        <el-button link style="width: 100%; margin-top: 8px" @click="back">
          {{ t('login.mfaBack') }}
        </el-button>
      </el-form>
      <div class="foot">
        <span>{{ t('login.noAccount') }}</span>
        <router-link to="/register">{{ t('login.register') }}</router-link>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { landingPath } from '../router';
import { ElMessage } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';

const router = useRouter();
const { t } = useI18n();
const auth = useAuth();
const loading = ref(false);
const unverified = ref(false);
const form = reactive({ email: '', password: '' });
/** 开了两步验证时, 密码通过后拿到的是挑战票据, 还要再输一次验证码 */
const challenge = ref('');
const code = ref('');

type LoginUser = Parameters<typeof auth.setLogin>[2];

function finish(d: { access_token: string; refresh_token: string; user: LoginUser }): void {
  auth.setLogin(d.access_token, d.refresh_token, d.user);
  ElMessage.success(t('login.welcome', { email: d.user.email }));
  // 平台账号进开发者管理，开发者按权限进自己的第一个页面
  void router.push(landingPath());
}

async function submit(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.post('/admin/v1/auth/login', {
      email: form.email,
      password: form.password,
    });
    const d = data.data;
    if (d.mfa_required) {
      challenge.value = d.challenge_token as string;
      return;
    }
    finish(d);
  } catch (e) {
    const err = (e as { response?: { data?: { error?: { code?: string } } } }).response?.data?.error
      ?.code;
    unverified.value = err === 'EMAIL_NOT_VERIFIED';
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function verify(): Promise<void> {
  if (!code.value.trim()) return ElMessage.error(t('login.mfaNeedCode'));
  loading.value = true;
  try {
    const { data } = await api.post('/admin/v1/auth/mfa/verify', {
      challenge_token: challenge.value,
      code: code.value.trim(),
    });
    finish(data.data);
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

function back(): void {
  challenge.value = '';
  code.value = '';
}

async function resend(): Promise<void> {
  try {
    const { data } = await api.post('/admin/v1/auth/resend-verification', { email: form.email });
    const dev = data.data.dev_code as string | undefined;
    ElMessage.success(dev ? t('login.resentDev', { code: dev }) : t('login.resent'));
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}
</script>

<style scoped>
.login-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: #f2f3f5;
}
.login-card {
  width: 380px;
}
.foot {
  margin-top: 12px;
  text-align: center;
  font-size: 13px;
  color: #909399;
}
.foot a {
  color: var(--el-color-primary);
  text-decoration: none;
}
.verify-hint {
  margin-bottom: 12px;
}
.to-register {
  margin-left: 8px;
  color: var(--el-color-primary);
  text-decoration: none;
  font-size: 13px;
}
</style>
