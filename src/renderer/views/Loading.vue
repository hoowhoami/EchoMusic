<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { registerDevice } from '@/api/user';
import { iconTriangleAlert } from '@/icons';
import { useDeviceStore, type DeviceInfo } from '@/stores/device';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import { useUserStore } from '@/stores/user';
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
let disposeStatusListener: (() => void) | undefined;
let isNavigating = false;

const extractDeviceInfo = (payload: unknown): DeviceInfo | null => {
  if (!payload || typeof payload !== 'object') return null;

  const record = payload as Record<string, unknown>;
  const data = record.data;

  if (!data || typeof data !== 'object') return null;

  const device = data as Record<string, unknown>;
  const dfid = typeof device.dfid === 'string' ? device.dfid : '';

  if (!dfid) return null;

  return {
    ...deviceStore.info,
    dfid,
    mid: typeof device.mid === 'string' ? device.mid : deviceStore.info?.mid,
    uuid: typeof device.uuid === 'string' ? device.uuid : deviceStore.info?.uuid,
    guid: typeof device.guid === 'string' ? device.guid : deviceStore.info?.guid,
    serverDev:
      typeof device.serverDev === 'string' ? device.serverDev : deviceStore.info?.serverDev,
    mac: typeof device.mac === 'string' ? device.mac : deviceStore.info?.mac,
    appid: typeof device.appid === 'string' ? device.appid : deviceStore.info?.appid,
    clientver:
      typeof device.clientver === 'string' ? device.clientver : deviceStore.info?.clientver,
  };
};

const navigateToHome = () => {
  if (isNavigating) return;
  isNavigating = true;
  router.push('/main/home');
};

const ensureDeviceReady = async () => {
  if (deviceStore.info?.dfid || isDeviceReady.value) {
    isDeviceReady.value = true;
    return;
  }

  statusMessage.value = '正在注册设备信息...';

  let response: unknown;
  try {
    response = await registerDevice();
  } catch {
    toastStore.actionFailed('注册设备');
    throw new Error('设备注册失败');
  }

  const deviceInfo = extractDeviceInfo(response);
  if (!deviceInfo?.dfid) {
    throw new Error('设备注册失败');
  }

  deviceStore.setDeviceInfo(deviceInfo);
  isDeviceReady.value = true;
  logger.info('Loading', 'Device registered', deviceInfo);
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

  await maybeAutoReceiveVip();

  statusMessage.value = '引擎就绪，正在开启音乐世界...';
  window.setTimeout(() => {
    navigateToHome();
  }, 800);
};

const applyStatus = async (status: ApiServerStatus) => {
  logger.info('Loading', 'API status changed', status);

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

  if (status.state === 'failed') {
    statusMessage.value = status.error || '服务启动失败';
    hasError.value = true;
    return;
  }

  hasError.value = false;
  statusMessage.value =
    status.state === 'starting' ? '正在初始化音乐引擎...' : '正在等待音乐引擎启动...';
};

const initStatus = async () => {
  try {
    const status = await window.electron.apiServer.status();
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
  statusMessage.value = '正在重新启动音乐引擎...';

  const result = await window.electron.apiServer.start();
  if (!result?.success) {
    statusMessage.value = result?.error || '服务启动失败';
    hasError.value = true;
  }
};

const closeWindow = () => {
  window.close();
};

onMounted(async () => {
  disposeStatusListener = window.electron.apiServer.onStatusChanged((status) => {
    void applyStatus(status);
  });

  await initStatus();
});

onUnmounted(() => {
  disposeStatusListener?.();
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
          <Button variant="primary" size="sm" @click="retryStart">
            重试启动
          </Button>
          <Button variant="secondary" size="sm" @click="closeWindow">
            退出应用
          </Button>
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
