<script setup lang="ts">
defineOptions({ name: 'loading-page' });
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { iconTriangleAlert } from '@/icons';
import { useDeviceStore } from '@/stores/device';
import { useToastStore } from '@/stores/toast';
import { ensureDevice } from '@/utils/device';
import logger from '@/utils/logger';
import { markStartup } from '@/utils/startupTiming';
import Button from '@/components/ui/Button.vue';
import OverlayHeader from '@/layouts/OverlayHeader.vue';
import type { ApiServerStatus } from '@/../shared/apiServer';

const router = useRouter();
const deviceStore = useDeviceStore();
const toastStore = useToastStore();
const statusMessage = ref('正在初始化音乐引擎...');
const hasError = ref(false);
const isDeviceReady = ref(false);
const hasCompletedStartup = ref(false);
const canForceEnter = ref(false);
const forceEnterHint = ref('');
let isNavigating = false;

const clearForceEnter = () => {
  canForceEnter.value = false;
  forceEnterHint.value = '';
};

const allowForceEnter = (hint: string) => {
  canForceEnter.value = true;
  forceEnterHint.value = hint;
};

const ensureDeviceReady = async () => {
  if (isDeviceReady.value) {
    isDeviceReady.value = true;
    return true;
  }

  statusMessage.value = deviceStore.info?.dfid ? '正在同步设备信息...' : '正在注册设备信息...';

  try {
    await ensureDevice();
  } catch (error) {
    logger.warn('Loading', 'Device register failed:', error);
    toastStore.actionFailed('注册设备');
    return false;
  }

  if (!deviceStore.info?.dfid) {
    toastStore.actionFailed('注册设备');
    return false;
  }

  isDeviceReady.value = true;
  logger.info('Loading', 'Device registered', deviceStore.info);
  return true;
};

const navigateToHome = () => {
  if (isNavigating) return;
  isNavigating = true;
  router.push('/main');
};

const completeStartup = async () => {
  if (hasCompletedStartup.value) return;
  hasCompletedStartup.value = true;
  clearForceEnter();

  // 检查播放引擎是否可用
  statusMessage.value = '正在检查播放引擎...';
  try {
    const playerReady = await window.electron?.player?.available();
    if (!playerReady) {
      logger.error('Loading', 'player engine is not available');
      statusMessage.value = '播放引擎初始化失败';
      hasError.value = true;
      allowForceEnter('可继续进入，播放功能暂不可用。');
      hasCompletedStartup.value = false;
      return;
    }
    logger.info('Loading', 'player engine is available');
  } catch (error) {
    logger.error('Loading', 'player availability check failed:', error);
    statusMessage.value = '播放引擎检查失败';
    hasError.value = true;
    allowForceEnter('可继续进入，播放功能暂不可用。');
    hasCompletedStartup.value = false;
    return;
  }

  statusMessage.value = '引擎就绪，正在开启音乐世界...';
  window.setTimeout(() => {
    navigateToHome();
  }, 200);
};

const applyStatus = async (status: ApiServerStatus) => {
  logger.info('Loading', 'API status', status);

  if (status.state === 'ready') {
    hasError.value = false;
    clearForceEnter();
    try {
      const deviceReady = await ensureDeviceReady();
      if (!deviceReady) {
        logger.error('Loading', 'Device init failed: device register failed');
        statusMessage.value = '设备注册失败';
        hasError.value = true;
        allowForceEnter('可继续进入，部分在线功能受限。');
        return;
      }
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
  clearForceEnter();
  statusMessage.value = '正在重新启动...';

  // 尝试重启播放引擎
  try {
    await window.electron?.player?.restart();
  } catch (error) {
    logger.warn('Loading', 'player restart attempt failed:', error);
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

const forceEnterApp = async () => {
  logger.warn('Loading', 'Force entering app despite startup issue:', statusMessage.value);
  hasCompletedStartup.value = false;
  hasError.value = false;
  clearForceEnter();
  navigateToHome();
};

onMounted(async () => {
  markStartup('loading-mounted');
  // 提前预加载主界面相关 chunk，利用启动等待时间，缩短跳转后首屏挂载前的等待
  void import('@/layouts/MainLayout.vue').catch(() => {});
  void import('@/views/Home.vue').catch(() => {});
  await initStatus();
  markStartup('status-check-complete');
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

    <div class="absolute inset-0 bg-linear-to-b from-bg-sidebar to-bg-main opacity-50"></div>

    <div
      class="absolute -top-25 -right-25 w-75 h-75 rounded-full bg-primary/5 dark:bg-primary/10 blur-3xl"
    ></div>

    <main class="startup-main">
      <div class="startup-mark">
        <span class="startup-mark-echo">Echo</span>
        <span class="startup-mark-music">Music</span>
      </div>
      <div v-if="!hasError" class="startup-progress">
        <div class="startup-dots" aria-hidden="true"><i></i><i></i><i></i></div>
        <p class="startup-status">{{ statusMessage }}</p>
      </div>

      <div v-else class="flex flex-col items-center space-y-6 px-10">
        <div class="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mb-2">
          <Icon class="text-red-500" :icon="iconTriangleAlert" width="32" height="32" />
        </div>
        <div class="w-full max-w-sm space-y-2 text-center">
          <h2 class="text-lg font-bold text-red-500/90">
            {{ canForceEnter ? '启动未完全就绪' : '启动失败' }}
          </h2>
          <p class="text-sm font-medium leading-6 text-text-main wrap-anywhere">
            {{ statusMessage }}
          </p>
          <p v-if="forceEnterHint" class="text-xs leading-5 text-text-secondary text-pretty">
            {{ forceEnterHint }}
          </p>
        </div>
        <div class="flex flex-wrap justify-center gap-4 pt-6 no-drag">
          <Button v-if="canForceEnter" variant="primary" size="default" @click="forceEnterApp">
            仍然进入
          </Button>
          <Button variant="primary" size="default" @click="retryStart"> 重试启动 </Button>
          <Button variant="secondary" size="default" @click="closeWindow"> 退出应用 </Button>
        </div>
      </div>
    </main>

    <footer class="startup-footer">EchoMusic • 音为你而生</footer>
  </div>
</template>

<style scoped>
.startup-main {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.startup-mark {
  box-sizing: border-box;
  width: 120px;
  height: 120px;
  margin-bottom: 60px;
  border: 1px solid var(--border-subtle, #e5e5e8);
  border-radius: 32px;
  background: var(--color-bg-elevated, #fff);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-shadow: 0 1px 3px rgb(0 0 0 / 10%);
}
.startup-mark-echo {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -1px;
  line-height: 1.25;
}
.startup-mark-music {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 2px;
  line-height: 1.25;
  text-transform: uppercase;
  color: var(--color-primary-text, #0071e3);
}
.startup-progress {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
}
.startup-dots {
  display: flex;
  align-items: center;
  gap: 6px;
}
.startup-dots i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-primary, #0071e3) 60%, transparent);
  animation: startup-bounce 0.8s infinite cubic-bezier(0.45, 0.05, 0.55, 0.95);
}
.startup-dots i:nth-child(1) {
  animation-delay: -0.3s;
}
.startup-dots i:nth-child(2) {
  animation-delay: -0.15s;
}
.startup-status {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.5px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--color-text-main, #1d1d1f) 60%, transparent);
}
.startup-footer {
  position: absolute;
  bottom: 40px;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 12px;
  line-height: 1.5;
  font-weight: 700;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--color-text-main, #1d1d1f) 40%, transparent);
}
:global(html.dark .startup-mark) {
  background: var(--color-bg-elevated, #36363a);
  border-color: var(--border-subtle, #48484b);
}
:global(html.dark .startup-mark-music) {
  color: var(--color-primary-text, #61adf5);
}
:global(html.dark .startup-status) {
  color: color-mix(in srgb, var(--color-text-main, #f5f5f7) 40%, transparent);
}
:global(html.dark .startup-footer) {
  color: color-mix(in srgb, var(--color-text-main, #f5f5f7) 40%, transparent);
}
@keyframes startup-bounce {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-8px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .startup-dots i {
    animation: none;
  }
}
</style>
