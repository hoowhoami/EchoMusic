<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import { iconArrowUp } from '@/icons';
import Button from '@/components/ui/Button.vue';

const props = defineProps<{
  scrollContainer?: HTMLElement | null;
  threshold?: number;
}>();

const visible = ref(false);
let currentTarget: HTMLElement | null = null;

const handleScroll = () => {
  if (!currentTarget) return;
  visible.value = currentTarget.scrollTop > (props.threshold || 300);
};

const scrollToTop = () => {
  if (!currentTarget) return;
  currentTarget.scrollTo({
    top: 0,
    behavior: 'smooth',
  });
};

const unbind = () => {
  if (currentTarget) {
    currentTarget.removeEventListener('scroll', handleScroll);
    currentTarget = null;
  }
  visible.value = false;
};

const bind = (el: HTMLElement | null) => {
  unbind();
  if (!el) return;
  currentTarget = el;
  currentTarget.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();
};

// 响应式监听 scrollContainer 变化
watch(
  () => props.scrollContainer,
  (el) => {
    bind(el ?? null);
  },
  { immediate: true },
);

onUnmounted(() => {
  unbind();
});
</script>

<template>
  <Transition name="fade">
    <Button
      variant="unstyled"
      size="none"
      v-if="visible"
      @click="scrollToTop"
      class="fixed right-8 bottom-32 z-50 p-3 rounded-full back-to-top-btn shadow-lg hover:shadow-xl transition-all duration-300 active:scale-95 group"
      aria-label="回到顶部"
    >
      <Icon
        class="transition-transform group-hover:-translate-y-1"
        :icon="iconArrowUp"
        width="20"
        height="20"
      />
    </Button>
  </Transition>
</template>

<style scoped>
@reference "@/style.css";

.back-to-top-btn {
  background: #ffffff;
  color: #1d1d1f;
  border: 1px solid rgba(0, 0, 0, 0.08);
}

.dark .back-to-top-btn {
  background: #2c2c2e;
  color: #f5f5f7;
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.back-to-top-btn:hover {
  color: var(--color-primary);
}

.dark .back-to-top-btn:hover {
  color: var(--color-primary);
}

.fade-enter-active,
.fade-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
