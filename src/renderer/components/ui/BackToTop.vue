<script setup lang="ts">
import { ref, watch, onUnmounted, onActivated, onDeactivated } from 'vue';
import { iconArrowUp } from '@/icons';
import Button from '@/components/ui/Button.vue';

const props = defineProps<{
  scrollContainer?: HTMLElement | null;
  threshold?: number;
}>();

const visible = ref(false);
let currentTarget: HTMLElement | null = null;
let suspended = false;
let disposed = false;

const handleScroll = () => {
  if (!currentTarget) return;
  visible.value = currentTarget.scrollTop > (props.threshold ?? 300);
};

const scrollToTop = () => {
  if (!currentTarget) return;
  currentTarget.scrollTo({ top: 0, behavior: 'instant' });
};

const unbind = () => {
  if (currentTarget) {
    currentTarget.removeEventListener('scroll', handleScroll);
    currentTarget = null;
  }
  visible.value = false;
};

const bind = (el: HTMLElement | null) => {
  if (disposed || suspended) return;
  if (currentTarget === el) {
    handleScroll();
    return;
  }
  unbind();
  if (!el) return;
  currentTarget = el;
  currentTarget.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();
};

// 容器或阈值变化时立即重新判断；同一容器不重复绑定。
watch(
  [() => props.scrollContainer, () => props.threshold],
  ([el]) => {
    bind(el ?? null);
  },
  { immediate: true },
);

onDeactivated(() => {
  suspended = true;
  unbind();
});
onActivated(() => {
  if (disposed) return;
  suspended = false;
  bind(props.scrollContainer ?? null);
});
onUnmounted(() => {
  disposed = true;
  unbind();
});
</script>

<template>
  <Transition name="back-to-top">
    <div v-if="visible" class="absolute right-6 bottom-4 z-50">
      <Button
        variant="unstyled"
        size="none"
        @click="scrollToTop"
        class="size-9 inline-flex items-center justify-center rounded-full border border-[var(--control-border)] back-to-top-btn shadow-lg hover:shadow-xl group"
        aria-label="回到顶部"
      >
        <Icon class="back-to-top-icon" :icon="iconArrowUp" width="18" height="18" />
      </Button>
    </div>
  </Transition>
</template>

<style scoped>
@reference "@/style.css";

.back-to-top-btn {
  background: var(--color-bg-elevated);
  color: var(--color-text-main);
  border-color: var(--control-border);
  backdrop-filter: var(--surface-backdrop-filter);
}

.back-to-top-btn:hover {
  color: var(--color-primary-text);
}

:global(.dark .back-to-top-btn) {
  border-color: rgba(255, 255, 255, 0.26) !important;
}

:global(.dark .back-to-top-btn:hover) {
  color: var(--color-primary-text);
}

.back-to-top-leave-active {
  pointer-events: none;
}

@media (prefers-reduced-motion: no-preference) {
  .back-to-top-enter-active {
    transition: opacity var(--motion-duration-fast) var(--motion-ease-enter);
  }

  .back-to-top-leave-active {
    transition: opacity var(--motion-duration-fast) var(--motion-ease-exit);
  }

  .back-to-top-enter-from,
  .back-to-top-leave-to {
    opacity: 0;
  }

  .back-to-top-icon {
    transition: translate var(--motion-duration-fast) var(--motion-ease-standard);
  }

  .back-to-top-btn:hover .back-to-top-icon {
    translate: 0 -2px;
  }
}
</style>
