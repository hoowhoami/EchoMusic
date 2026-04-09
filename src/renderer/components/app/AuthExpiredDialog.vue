<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const authStore = useAuthStore();

const open = computed({
  get: () => authStore.sessionExpiredDialogOpen,
  set: (value: boolean) => {
    if (!value) authStore.hideSessionExpiredDialog();
  },
});

const handleLogin = async () => {
  authStore.hideSessionExpiredDialog();
  if (router.currentRoute.value.name !== 'login') {
    await router.push({ name: 'login' });
  }
};
</script>

<template>
  <Dialog
    v-model:open="open"
    :title="authStore.sessionExpiredPayload.title"
    :description="authStore.sessionExpiredPayload.description"
    contentClass="auth-expired-dialog"
  >
    <template #footer>
      <Button
        class="auth-expired-btn auth-expired-btn--ghost"
        variant="outline"
        size="sm"
        @click="authStore.hideSessionExpiredDialog()"
      >
        稍后再说
      </Button>
      <Button
        class="auth-expired-btn auth-expired-btn--primary"
        variant="primary"
        size="sm"
        @click="handleLogin"
      >
        去登录
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

:global(.auth-expired-dialog) {
  @apply w-[420px] max-w-[92vw];
}

.auth-expired-btn {
  @apply min-w-[96px] rounded-lg text-[13px] font-semibold;
}

.auth-expired-btn--ghost {
  @apply text-text-secondary hover:text-text-main;
}

.auth-expired-btn--primary {
}
</style>
