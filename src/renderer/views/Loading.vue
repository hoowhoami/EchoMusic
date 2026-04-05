<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { registerDevice } from '@/api/user';
import { iconTriangleAlert } from '@/icons';
import { useDeviceStore, type DeviceInfo } from '@/stores/device';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import logger from '@/utils/logger';
import Button from '@/components/ui/Button.vue';

const router = useRouter();
const deviceStore = useDeviceStore();
const userStore = useUserStore();
const toastStore = useToastStore();
const statusMessage = ref('正在初始化音乐引擎...');
const hasError = ref(false);

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

const ensureDeviceReady = async () => {
  if (deviceStore.info?.dfid) {
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
  logger.info('Loading', 'Device registered', deviceInfo);
};

const startServer = async () => {
  try {
    statusMessage.value = '正在初始化音乐引擎...';
    hasError.value = false;

    // 调用主进程暴露的 API Server 启动方法
    const result = await window.electron.apiServer.start();

    if (result && result.success) {
      await ensureDeviceReady();

      statusMessage.value = '引擎就绪，正在开启音乐世界...';
      // 增加一点点延迟，让用户看清状态切换
      setTimeout(() => {
        navigateToHome();
      }, 800);
    } else {
      statusMessage.value = result?.error || '服务启动失败';
      hasError.value = true;
    }
  } catch (e) {
    logger.error('Loading', 'Start error:', e);
    statusMessage.value = '启动异常: ' + e;
    hasError.value = true;
  }
};

const navigateToHome = () => {
  router.push('/main/home');
};

const closeWindow = () => {
  window.close();
};

onMounted(() => {
  startServer();
});
</script>

<template>
  <div
    class="loading-view h-full w-full relative overflow-hidden bg-bg-main text-text-main select-none transition-colors duration-500"
  >
    <!-- 1. 背景渐变 -->
    <div class="absolute inset-0 bg-gradient-to-b from-bg-sidebar to-bg-main opacity-50"></div>

    <!-- 2. 装饰圆 -->
    <div
      class="absolute -top-[100px] -right-[100px] w-[300px] h-[300px] rounded-full bg-primary/5 dark:bg-primary/10 blur-3xl"
    ></div>

    <!-- 3. 拖拽区域 -->
    <div class="absolute top-0 left-0 right-0 h-12 drag"></div>

    <!-- 4. 主体内容 -->
    <main class="relative h-full flex flex-col items-center justify-center">
      <!-- Logo 容器 -->
      <div
        class="w-[120px] h-[120px] bg-bg-card border border-border-light rounded-[32px] flex flex-col items-center justify-center shadow-sm mb-[60px]"
      >
        <span class="text-[24px] font-bold text-text-main tracking-[-1px] leading-tight">Echo</span>
        <span class="text-[16px] font-bold text-primary tracking-[2px] leading-tight uppercase"
          >Music</span
        >
      </div>

      <!-- 动画 & 状态 -->
      <div v-if="!hasError" class="flex flex-col items-center space-y-6">
        <!-- 三点跳动动画 -->
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

      <!-- 错误状态 -->
      <div v-else class="flex flex-col items-center space-y-6 px-10">
        <div class="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mb-2">
          <Icon class="text-red-500" :icon="iconTriangleAlert" width="32" height="32" />
        </div>
        <div class="text-center space-y-2">
          <h2 class="text-lg font-bold text-red-500/90">启动失败</h2>
          <p class="text-sm text-text-secondary max-w-xs">{{ statusMessage }}</p>
        </div>
        <div class="flex gap-4 pt-6 no-drag">
          <Button variant="primary" size="sm" @click="startServer">
            重试启动
          </Button>
          <Button variant="secondary" size="sm" @click="closeWindow">
            退出应用
          </Button>
        </div>
      </div>
    </main>

    <!-- 5. 底部标语 -->
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
