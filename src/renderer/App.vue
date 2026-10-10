<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import TooltipScope from '@/components/ui/TooltipScope.vue';
import SettingsDialog from '@/components/app/SettingsDialog.vue';
import ToastViewport from '@/components/app/ToastViewport.vue';
import RouteErrorBoundary from '@/components/app/RouteErrorBoundary.vue';
import { useLyricPageTransition } from '@/composables/useLyricPageTransition';
import { loadLyricPage } from '@/views/lyric/loaders';
import { pageTransitionState } from '@/plugins/runtime/theme';
import { useAppRuntime } from '@/app/useAppRuntime';
const AuthExpiredDialog = defineAsyncComponent(
  () => import('@/components/app/AuthExpiredDialog.vue'),
);
const KugouVerificationFlow = defineAsyncComponent(
  () => import('@/components/app/KugouVerificationFlow.vue'),
);
const UpdateDialog = defineAsyncComponent(() => import('@/components/app/UpdateDialog.vue'));
const LyricView = defineAsyncComponent(loadLyricPage);
const route = useRoute();
const isMiniPlayerWindow = () => {
  const hashPath = window.location.hash.replace(/^#/, '').split(/[?#]/)[0];
  return (
    route.name === 'mini-player' || route.path === '/mini-player' || hashPath === '/mini-player'
  );
};
const isMiniPlayerRoute = computed(isMiniPlayerWindow);
// 首屏从 loading 切到主界面时跳过根级过渡，避免 out-in "先淡出旧页 → 空档" 造成的白屏
const suppressRootTransition = ref(false);
const rootPageTransitionName = computed(() =>
  isMiniPlayerRoute.value || suppressRootTransition.value || !pageTransitionState.enabled
    ? undefined
    : pageTransitionState.name,
);
const rootPageTransitionMode = computed(() =>
  suppressRootTransition.value || pageTransitionState.mode === 'default'
    ? undefined
    : pageTransitionState.mode,
);
const rootPageTransitionAppear = computed(
  () =>
    !isMiniPlayerRoute.value &&
    !suppressRootTransition.value &&
    pageTransitionState.enabled &&
    pageTransitionState.appear,
);
const rootPageTransitionKey = computed(() => route.matched[0]?.path ?? route.fullPath);
const player = useAppRuntime(isMiniPlayerRoute);
const lyricTransition = useLyricPageTransition();
watch(
  () => route.name,
  (toName, fromName) => {
    suppressRootTransition.value = fromName === 'loading' && toName !== 'loading';
  },
);
</script>

<template>
  <TooltipScope>
    <RouterView v-slot="{ Component, route }">
      <Transition
        :name="rootPageTransitionName"
        :mode="rootPageTransitionMode"
        :appear="rootPageTransitionAppear"
      >
        <RouteErrorBoundary :key="rootPageTransitionKey" :route="route">
          <component :is="Component" />
        </RouteErrorBoundary>
      </Transition>
    </RouterView>
    <Teleport v-if="!isMiniPlayerRoute" to="body">
      <Transition
        :css="false"
        appear
        @before-enter="lyricTransition.beforeEnter"
        @enter="lyricTransition.enter"
        @leave="lyricTransition.leave"
        @enter-cancelled="lyricTransition.cancel"
        @leave-cancelled="lyricTransition.cancel"
      >
        <!-- Mount the host synchronously, even while the lyric chunk is loading.
             Reveal the retained page as soon as the leave transition starts. -->
        <div v-if="player?.isLyricViewOpen" class="lyric-overlay-host" data-entering>
          <LyricView />
        </div>
      </Transition>
    </Teleport>
    <AuthExpiredDialog v-if="!isMiniPlayerRoute" />
    <KugouVerificationFlow v-if="!isMiniPlayerRoute" />
    <ToastViewport v-if="!isMiniPlayerRoute" :lyric-view-open="Boolean(player?.isLyricViewOpen)" />
    <UpdateDialog v-if="!isMiniPlayerRoute" dismiss-label="稍后" />
    <SettingsDialog v-if="!isMiniPlayerRoute" />
  </TooltipScope>
</template>

<style>
/* 歌词覆盖层动画 */
.lyric-overlay-host {
  position: fixed;
  inset: 0;
  z-index: 1300;
}

.lyric-overlay-host[data-leaving] {
  pointer-events: none;
}

.lyric-cover-flight {
  position: fixed;
  z-index: 1350;
  contain: layout paint;
  pointer-events: none;
  transform-origin: top left;
  will-change: transform;
}

.lyric-cover-flight-clip {
  position: absolute;
  inset: 0;
  overflow: hidden;
  will-change: opacity;
}

.lyric-cover-flight-clip * {
  animation: none !important;
  transition: none !important;
}

.lyric-overlay-host[data-motion='cover'],
.lyric-overlay-host[data-motion='fade'] {
  will-change: opacity;
}
</style>
