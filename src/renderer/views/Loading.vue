<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { iconTriangleAlert } from '@/icons';
import { useDeviceStore } from '@/stores/device';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import { useUserStore } from '@/stores/user';
import { ensureDevice } from '@/utils/device';
import logger from '@/utils/logger';
import Button from '@/components/ui/Button.vue';
import OverlayHeader from '@/layouts/OverlayHeader.vue';
import type { ApiServerStatus } from '@/../shared/api-server';

const router = useRouter();
const deviceStore = useDeviceStore();
const settingStore = useSettingStore();
const toastStore = useToastStore();
const userStore = useUserStore();
const statusMessage = ref('正在初始化音乐引擎...');
const hasError = ref(false);
const isDeviceReady = ref(false);
const hasCompletedStartup = ref(false);
let isNavigating = false;

const ensureDeviceReady = async () => {
  if (deviceStore.info?.dfid || isDeviceReady.value) {
    isDeviceReady.value = true;
    return;
  }

  statusMessage.value = '正在注册设备信息...';

  try {
    await ensureDevice();
  } catch {
    toastStore.actionFailed('注册设备');
    throw new Error('设备注册失败');
  }

  if (!deviceStore.info?.dfid) {
    throw new Error('设备注册失败');
  }

  isDeviceReady.value = true;
  logger.info('Loading', 'Device registered', deviceStore.info);
};

const navigateToHome = () => {
  if (isNavigating) return;
  isNavigating = true;
  router.push('/main/home');
};

const maybeAutoReceiveVip = async () => {
  if (!settingStore.autoReceiveVip || !userStore.isLoggedIn) return;

  try {
    await userStore.fetchUserInfoOnce();
    await userStore.autoReceiveVipIfNeeded();
  } catch (error) {
    logger.warn('Loading', 'Auto receive VIP after startup skipped:', error);
  }
};

const completeStartup = async () => {
  if (hasCompletedStartup.value) return;
  hasCompletedStartup.value = true;

  // 检查 mpv 播放引擎是否可用
  statusMessage.value = '正在检查播放引擎...';
  try {
    const mpvReady = await window.electron?.mpv?.available();
    if (!mpvReady) {
      logger.error('Loading', 'mpv player engine is not available');
      statusMessage.value = '播放引擎初始化失败';
      hasError.value = true;
      hasCompletedStartup.value = false;
      return;
    }
    logger.info('Loading', 'mpv player engine is available');
  } catch (error) {
    logger.error('Loading', 'mpv availability check failed:', error);
    statusMessage.value = '播放引擎检查失败';
    hasError.value = true;
    hasCompletedStartup.value = false;
    return;
  }

  await maybeAutoReceiveVip();

  statusMessage.value = '引擎就绪，正在开启音乐世界...';
  window.setTimeout(() => {
    navigateToHome();
  }, 800);
};

const applyStatus = async (status: ApiServerStatus) => {
  logger.info('Loading', 'API status', status);

  if (status.state === 'ready') {
    hasError.value = false;
    try {
      await ensureDeviceReady();
      await completeStartup();
    } catch (error) {
      logger.error('Loading', 'Device init failed:', error);
      statusMessage.value = error instanceof Error ? error.message : String(error);
      hasError.value = true;
    }
    return;
  }

  // idle 或 failed 都视为需要启动
  statusMessage.value = status.error || '服务未就绪';
  hasError.value = true;
};

const initStatus = async () => {
  try {
    let status = await window.electron.apiServer.status();

    // 如果还没就绪，主动触发初始化
    if (status.state !== 'ready') {
      statusMessage.value = '正在初始化音乐引擎...';
      const result = await window.electron.apiServer.start();
      if (!result?.success) {
        statusMessage.value = result?.error || '服务启动失败';
        hasError.value = true;
        return;
      }
      status = await window.electron.apiServer.status();
    }

    await applyStatus(status);
  } catch (error) {
    logger.error('Loading', 'Status init failed:', error);
    statusMessage.value = '读取启动状态失败';
    hasError.value = true;
  }
};

const retryStart = async () => {
  hasCompletedStartup.value = false;
  hasError.value = false;
  statusMessage.value = '正在重新启动...';

  // 尝试重启 mpv 播放引擎
  try {
    await window.electron?.mpv?.restart();
  } catch (error) {
    logger.warn('Loading', 'mpv restart attempt failed:', error);
  }

  try {
    const result = await window.electron.apiServer.start();
    if (!result?.success) {
      statusMessage.value = result?.error || '服务启动失败';
      hasError.value = true;
      return;
    }
    const status = await window.electron.apiServer.status();
    await applyStatus(status);
  } catch (error) {
    logger.error('Loading', 'Retry failed:', error);
    statusMessage.value = error instanceof Error ? error.message : String(error);
    hasError.value = true;
  }
};

const closeWindow = () => {
  window.close();
};

onMounted(async () => {
  await initStatus();
});

onUnmounted(() => {
  // 清理（保留钩子以备将来扩展）
});
</script>

<template>
  <div
    class="loading-view h-full w-full relative overflow-hidden bg-bg-main text-text-main select-none transition-colors duration-500"
  >
    <OverlayHeader />

    <div class="absolute inset-0 bg-gradient-to-b from-bg-sidebar to-bg-main opacity-50"></div>

    <div
      class="absolute -top-[100px] -right-[100px] w-[300px] h-[300px] rounded-full bg-primary/5 dark:bg-primary/10 blur-3xl"
    ></div>

    <main class="relative h-full flex flex-col items-center justify-center">
      <div
        class="w-[120px] h-[120px] bg-bg-card border border-border-light rounded-[32px] flex flex-col items-center justify-center shadow-sm mb-[60px]"
      >
        <span class="text-[24px] font-bold text-text-main tracking-[-1px] leading-tight">Echo</span>
        <span class="text-[16px] font-bold text-primary tracking-[2px] leading-tight uppercase"
          >Music</span
        >
      </div>

      <div v-if="!hasError" class="flex flex-col items-center space-y-6">
        <div class="flex items-center gap-1.5">
          <div
            class="w-2 h-2 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.3s]"
          ></div>
          <div
            class="w-2 h-2 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.15s]"
          ></div>
          <div class="w-2 h-2 rounded-full bg-primary/60 animate-bounce"></div>
        </div>

        <p
          class="text-[13px] font-bold text-text-main/60 dark:text-text-main/40 tracking-[0.5px] uppercase"
        >
          {{ statusMessage }}
        </p>
      </div>

      <div v-else class="flex flex-col items-center space-y-6 px-10">
        <div class="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mb-2">
          <Icon class="text-red-500" :icon="iconTriangleAlert" width="32" height="32" />
        </div>
        <div class="text-center space-y-2">
          <h2 class="text-lg font-bold text-red-500/90">启动失败</h2>
          <p class="text-sm text-text-secondary max-w-xs">{{ statusMessage }}</p>
        </div>
        <div class="flex gap-4 pt-6 no-drag">
          <Button variant="primary" size="sm" @click="retryStart"> 重试启动 </Button>
          <Button variant="secondary" size="sm" @click="closeWindow"> 退出应用 </Button>
        </div>
      </div>
    </main>

    <footer class="absolute bottom-10 left-0 right-0 text-center">
      <span
        class="text-[12px] font-bold text-text-main/40 uppercase tracking-[1.5px] tracking-widest"
        >EchoMusic • 音为你而生</span
      >
    </footer>
  </div>
</template>

<style scoped>
.loading-view {
  animation: fade-in 0.6s ease-out;
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.animate-bounce {
  animation: bounce 0.8s infinite cubic-bezier(0.45, 0.05, 0.55, 0.95);
}

@keyframes bounce {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-8px);
  }
}
</style>
