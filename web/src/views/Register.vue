<template>
  <div class="register-wrap">
    <el-card class="register-card">
      <h2>注册开发者账号</h2>
      <p class="sub">注册后立即开通，你会得到独立的开发者空间：自己的应用、授权码与团队成员。</p>
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
          注册并进入
        </el-button>
      </el-form>
      <div class="foot">
        <span>已有账号？</span>
        <router-link to="/login">返回登录</router-link>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';
import { landingPath } from '../router';

const router = useRouter();
const auth = useAuth();
const loading = ref(false);
const form = reactive({ developerName: '', email: '', password: '', confirm: '' });

async function submit(): Promise<void> {
  if (form.password.length < 8) {
    ElMessage.error('密码至少 8 位');
    return;
  }
  if (form.password !== form.confirm) {
    ElMessage.error('两次输入的密码不一致');
    return;
  }
  if (!form.developerName.trim()) {
    ElMessage.error('请填写开发者名称');
    return;
  }
  loading.value = true;
  try {
    const { data } = await api.post('/admin/v1/auth/register', {
      email: form.email,
      password: form.password,
      developer_name: form.developerName,
    });
    const d = data.data;
    auth.setLogin(d.access_token, d.refresh_token, d.user);
    ElMessage.success('注册成功，正在进入你的开发者空间');
    void router.push(landingPath());
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
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
</style>
