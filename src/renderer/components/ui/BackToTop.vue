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
        class="action-icon inline-flex items-center justify-center back-to-top-btn"
        aria-label="回到顶部"
      >
        <Icon class="back-to-top-icon" :icon="iconArrowUp" width="16" height="16" />
      </Button>
    </div>
  </Transition>
</template>

<style scoped>
@reference "@/style.css";

.back-to-top-btn {
  --back-to-top-hover-y: 0px;
  --back-to-top-active-scale: 1;
  width: var(--scroll-action-size);
  height: var(--scroll-action-size);
  background: var(--scroll-action-bg);
  color: var(--scroll-action-text);
  border: 1px solid var(--scroll-action-border);
  box-shadow: var(--control-neutral-action-shadow);
  -webkit-backdrop-filter: var(--surface-backdrop-filter);
  backdrop-filter: var(--surface-backdrop-filter);
  scale: 1;
  transform: translateY(var(--back-to-top-hover-y)) scale(var(--back-to-top-active-scale));
}

.back-to-top-btn:is(:hover, :focus-visible) {
  color: var(--scroll-action-hover-text);
  background: var(--scroll-action-hover-bg);
  border-color: var(--scroll-action-hover-border);
  --back-to-top-hover-y: -1px;
}

.back-to-top-btn:active {
  background: var(--scroll-action-pressed-bg);
  --back-to-top-active-scale: 0.96;
}

.back-to-top-leave-active {
  pointer-events: none;
}

@media (prefers-reduced-motion: no-preference) {
  .back-to-top-btn {
    transition:
      background-color var(--motion-duration-fast) var(--motion-ease-standard),
      color var(--motion-duration-fast) var(--motion-ease-standard),
      border-color var(--motion-duration-fast) var(--motion-ease-standard),
      box-shadow var(--motion-duration-fast) var(--motion-ease-standard),
      transform var(--motion-duration-fast) var(--motion-ease-standard);
  }

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

@media (prefers-reduced-motion: reduce) {
  .back-to-top-btn {
    transform: none;
  }
}
</style>
