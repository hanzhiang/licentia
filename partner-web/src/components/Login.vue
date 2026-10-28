<template>
  <main class="login-page">
    <section class="login-panel">
      <div class="brand-mark">LP</div>
      <p class="eyebrow">渠道与开发者</p>
      <h1>授权码发放工作台</h1>
      <p class="sub">使用分配给你的渠道账号登录，发放和导出你名下的授权码。</p>
      <el-form label-position="top" @keyup.enter="submit">
        <el-form-item label="账号">
          <el-input v-model="email" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="password" type="password" show-password autocomplete="current-password" />
        </el-form-item>
        <el-button type="primary" class="submit" :loading="loading" @click="submit">
          登录工作台
        </el-button>
      </el-form>
      <div class="demo">演示渠道账号：partner@demo.local / Passw0rd!demo</div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errMsg } from '../api';
import { saveSession, type SessionUser } from '../session';

const emit = defineEmits<{ success: [user: SessionUser] }>();
const email = ref('partner@demo.local');
const password = ref('');
const loading = ref(false);

async function submit(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.post('/admin/v1/auth/login', {
      email: email.value,
      password: password.value,
    });
    const user = data.data.user as SessionUser;
    if (!user.permissions.includes('license:issue')) {
      throw new Error('该账号没有授权码发放权限，请联系管理员');
    }
    saveSession(data.data.access_token, data.data.refresh_token, user);
    emit('success', user);
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    linear-gradient(120deg, rgba(20, 125, 114, 0.08), transparent 38%),
    #f4f7f6;
}
.login-panel {
  width: min(440px, 100%);
  padding: 34px;
  border: 1px solid #dfe7e5;
  border-radius: 8px;
  background: #fff;
}
.brand-mark {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: #147d72;
  color: #fff;
  font-weight: 700;
  font-size: 14px;
}
.eyebrow {
  margin: 22px 0 6px;
  color: #147d72;
  font-size: 12px;
  font-weight: 650;
}
h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
.sub { color: #69766f; line-height: 1.7; margin: 12px 0 24px; }
.submit { width: 100%; }
.demo {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid #edf1ef;
  color: #7a8580;
  font-size: 12px;
}
</style>
