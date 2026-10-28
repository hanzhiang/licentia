<template>
  <div class="login-wrap">
    <el-card class="login-card">
      <h2>授权与许可管理平台</h2>
      <el-form :model="form" label-width="0" @keyup.enter="submit">
        <el-form-item>
          <el-input v-model="form.email" placeholder="邮箱(如 operator@demo.local)" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.password" type="password" placeholder="密码" show-password />
        </el-form-item>
        <el-alert v-if="unverified" :closable="false" type="warning" class="verify-hint">
          <div>该邮箱尚未验证。</div>
          <el-button link type="primary" @click="resend">重新发送验证码</el-button>
          <router-link to="/register" class="to-register">去完成验证</router-link>
        </el-alert>
        <el-button type="primary" style="width: 100%" :loading="loading" @click="submit">
          登录
        </el-button>
      </el-form>
      <div class="foot">
        <span>还没有开发者账号？</span>
        <router-link to="/register">立即注册</router-link>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { landingPath } from '../router';
import { ElMessage } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';

const router = useRouter();
const auth = useAuth();
const loading = ref(false);
const unverified = ref(false);
const form = reactive({ email: '', password: '' });

async function submit(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.post('/admin/v1/auth/login', {
      email: form.email,
      password: form.password,
    });
    const d = data.data;
    auth.setLogin(d.access_token, d.refresh_token, d.user);
    ElMessage.success(`欢迎, ${d.user.email}(${d.user.actor_type})`);
    // 平台账号进开发者管理，开发者按权限进自己的第一个页面
    void router.push(landingPath());
  } catch (e) {
    const code = (e as { response?: { data?: { error?: { code?: string } } } }).response?.data
      ?.error?.code;
    unverified.value = code === 'EMAIL_NOT_VERIFIED';
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

async function resend(): Promise<void> {
  try {
    const { data } = await api.post('/admin/v1/auth/resend-verification', { email: form.email });
    const dev = data.data.dev_code as string | undefined;
    ElMessage.success(dev ? `验证码已发送(开发环境: ${dev})` : '验证码已发送，请查收邮件');
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
