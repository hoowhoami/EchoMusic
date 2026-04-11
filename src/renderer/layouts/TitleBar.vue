<script setup lang="ts">
import { computed, watch, ref, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import RefreshIcon from '@/components/ui/RefreshIcon.vue';
import { iconChevronLeft, iconChevronRight, iconMinus, iconSquare, iconX } from '@/icons';

const route = useRoute();
const router = useRouter();
const isMac = computed(() => window.electron.platform === 'darwin');

const canGoBack = ref(false);
const canGoForward = ref(false);

const updateNavState = () => {
  if (typeof window === 'undefined') return;
  const historyState = window.history.state as {
    back?: string | null;
    forward?: string | null;
  } | null;
  const skipCurrent = route.matched.some((record) => record.meta?.skipHistory === true);
  canGoBack.value = !skipCurrent && !!historyState?.back;
  canGoForward.value = !skipCurrent && !!historyState?.forward;
};

const handleControl = (action: 'minimize' | 'maximize' | 'close') => {
  window.electron.windowControl(action);
};

const goBack = () => {
  if (canGoBack.value) router.back();
};
const goForward = () => {
  if (canGoForward.value) router.forward();
};
const refresh = async () => {
  await router.replace({
    path: route.path,
    query: {
      ...route.query,
      _t: Date.now().toString(),
    },
    hash: route.hash,
  });
};

watch(
  () => route.fullPath,
  () => {
    updateNavState();
  },
  { immediate: true },
);

onMounted(() => {
  window.addEventListener('popstate', updateNavState);
});

onUnmounted(() => {
  window.removeEventListener('popstate', updateNavState);
});
</script>

<template>
  <header
    class="title-bar drag flex items-center shrink-0 select-none transition-colors duration-300 z-[100] bg-transparent"
  >
    <!-- 1. 左侧：导航按钮 (no-drag) -->
    <div class="flex items-center gap-1 no-drag pl-6">
      <Button
        variant="unstyled"
        size="none"
        @click="goBack"
        class="nav-btn group"
        :disabled="!canGoBack"
        title="后退"
      >
        <Icon
          :icon="iconChevronLeft"
          width="22"
          height="22"
          :class="[
            'text-text-main transition-opacity',
            canGoBack ? 'opacity-60 group-hover:opacity-100' : 'opacity-40',
          ]"
        />
      </Button>
      <Button
        variant="unstyled"
        size="none"
        @click="goForward"
        class="nav-btn group"
        :disabled="!canGoForward"
        title="前进"
      >
        <Icon
          :icon="iconChevronRight"
          width="22"
          height="22"
          :class="[
            'text-text-main transition-opacity',
            canGoForward ? 'opacity-60 group-hover:opacity-100' : 'opacity-40',
          ]"
        />
      </Button>
      <Button variant="unstyled" size="none" @click="refresh" class="nav-btn group" title="刷新">
        <RefreshIcon
          width="18"
          height="18"
          class="text-text-main opacity-60 group-hover:opacity-100 transition-opacity"
        />
      </Button>
    </div>

    <!-- 2. 中间：空白区域 -->
    <div class="flex-1 h-full"></div>

    <!-- 3. 右侧：窗口控制 (no-drag) -->
    <div v-if="!isMac" class="window-controls flex items-center no-drag h-full">
      <Button variant="unstyled" size="none" @click="handleControl('minimize')" class="control-btn">
        <Icon :icon="iconMinus" width="14" height="14" />
      </Button>
      <Button variant="unstyled" size="none" @click="handleControl('maximize')" class="control-btn">
        <Icon :icon="iconSquare" width="13" height="13" />
      </Button>
      <Button
        variant="unstyled"
        size="none"
        @click="handleControl('close')"
        class="control-btn hover:bg-red-500 hover:text-white"
      >
        <Icon :icon="iconX" width="14" height="14" />
      </Button>
    </div>
  </header>
</template>

<style scoped>
.title-bar {
  height: 38px;
}

.nav-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: all 0.2s;
  background: transparent;
  border: none;
}

.nav-btn:hover {
  background-color: rgba(0, 0, 0, 0.04);
}

.dark .nav-btn:hover {
  background-color: rgba(255, 255, 255, 0.04);
}

.control-btn {
  width: 46px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-main);
  background: transparent;
  border: none;
  transition: all 0.2s;
}

.control-btn:hover {
  background-color: rgba(0, 0, 0, 0.05);
}

.dark .control-btn:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.control-btn:hover.hover\:bg-red-500 {
  background-color: #ff3b30 !important;
}

.nav-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.nav-btn:disabled:hover {
  background-color: transparent;
}
</style>
