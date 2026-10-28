<template>
  <div class="register-wrap">
    <el-card class="register-card">
      <h2>{{ step === 1 ? '注册开发者账号' : '验证邮箱' }}</h2>

      <template v-if="step === 1">
        <p class="sub">
          注册后立即开通，你会得到独立的开发者空间：自己的应用、授权码与团队成员。
          为防滥用，需要先验证邮箱。
        </p>
        <el-form :model="form" label-width="0" @keyup.enter="submit">
          <el-form-item>
            <el-input v-model="form.developerName" placeholder="开发者/团队名称(如 某某软件工作室)" />
          </el-form-item>
          <el-form-item>
            <el-input v-model="form.email" placeholder="登录邮箱" />
          </el-form-item>
          <el-form-item>
            <el-input v-model="form.password" type="password" placeholder="密码(至少 8 位)" show-password />
          </el-form-item>
          <el-form-item>
            <el-input v-model="form.confirm" type="password" placeholder="确认密码" show-password />
          </el-form-item>
          <el-button type="primary" style="width: 100%" :loading="loading" @click="submit">
            注册
          </el-button>
        </el-form>
        <div class="foot">
          <span>已有账号？</span>
          <router-link to="/login">返回登录</router-link>
        </div>
      </template>

      <template v-else>
        <p class="sub">
          验证码已发送到 <strong>{{ form.email }}</strong>，15 分钟内有效。
          未配置邮件服务的环境下，验证码会直接显示在下面。
        </p>
        <el-alert v-if="devCode" :closable="false" type="info" class="dev-hint">
          开发环境验证码：<strong>{{ devCode }}</strong>
        </el-alert>
        <el-form label-width="0" @keyup.enter="verify">
          <el-form-item>
            <el-input v-model="code" maxlength="6" placeholder="6 位验证码" />
          </el-form-item>
          <el-button type="primary" style="width: 100%" :loading="loading" @click="verify">
            验证并进入
          </el-button>
        </el-form>
        <div class="foot">
          <el-button link type="primary" :disabled="cooldown > 0" @click="resend">
            {{ cooldown > 0 ? `重新发送(${cooldown}s)` : '重新发送验证码' }}
          </el-button>
          <router-link to="/login">返回登录</router-link>
        </div>
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';
import { landingPath } from '../router';

const router = useRouter();
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
  if (!form.developerName.trim()) return ElMessage.error('请填写开发者名称');
  if (form.password.length < 8) return ElMessage.error('密码至少 8 位');
  if (form.password !== form.confirm) return ElMessage.error('两次输入的密码不一致');

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
    ElMessage.success('注册成功，请查收验证码');
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function verify(): Promise<void> {
  if (!/^\d{6}$/.test(code.value)) return ElMessage.error('请输入 6 位验证码');
  loading.value = true;
  try {
    const { data } = await api.post('/admin/v1/auth/verify-email', {
      email: form.email,
      code: code.value,
    });
    const d = data.data;
    auth.setLogin(d.access_token, d.refresh_token, d.user);
    ElMessage.success('邮箱验证成功，正在进入你的开发者空间');
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
    ElMessage.success('验证码已重新发送');
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
