<template>
  <Login v-if="!user" @success="signedIn" />
  <Workbench v-else :user="user" @logout="logout" />
</template>

<script setup lang="ts">
import { ref } from 'vue';
import Login from './components/Login.vue';
import Workbench from './components/Workbench.vue';
import { clearSession, getUser, type SessionUser } from './session';

const user = ref<SessionUser | null>(getUser());

function signedIn(next: SessionUser): void {
  user.value = next;
}

function logout(): void {
  clearSession();
  user.value = null;
}
</script>
