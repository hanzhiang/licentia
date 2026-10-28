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
        <el-form-item>
          <el-input v-model="form.tenantId" placeholder="目标租户 ID(仅平台超管填写)" />
        </el-form-item>
        <el-button type="primary" style="width: 100%" :loading="loading" @click="submit">
          登录
        </el-button>
      </el-form>
      <p class="hint">演示账号: operator@demo.local / Passw0rd!demo(种子用户, pnpm seed:users)</p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errMsg } from '../api';
import { useAuth } from '../store';

const router = useRouter();
const auth = useAuth();
const loading = ref(false);
const form = reactive({ email: 'operator@demo.local', password: '', tenantId: '' });

async function submit(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.post('/admin/v1/auth/login', {
      email: form.email,
      password: form.password,
    });
    const d = data.data;
    auth.setLogin(d.access_token, d.refresh_token, d.user);
    if (form.tenantId.trim()) auth.setTenant(form.tenantId);
    ElMessage.success(`欢迎, ${d.user.email}(${d.user.actor_type})`);
    void router.push('/licenses');
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
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
.hint {
  color: #909399;
  font-size: 12px;
}
</style>
