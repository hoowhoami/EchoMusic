<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { iconArrowUp } from '@/icons';
import Button from '@/components/ui/Button.vue';

const props = defineProps<{
  targetSelector?: string;
  threshold?: number;
}>();

const visible = ref(false);
let scrollTarget: HTMLElement | null = null;

const handleScroll = () => {
  if (!scrollTarget) return;
  visible.value = scrollTarget.scrollTop > (props.threshold || 300);
};

const scrollToTop = () => {
  if (!scrollTarget) return;
  scrollTarget.scrollTo({
    top: 0,
    behavior: 'smooth',
  });
};

onMounted(() => {
  scrollTarget = props.targetSelector
    ? document.querySelector(props.targetSelector)
    : document.querySelector('.view-port');

  if (scrollTarget) {
    scrollTarget.addEventListener('scroll', handleScroll);
  }
});

onUnmounted(() => {
  if (scrollTarget) {
    scrollTarget.removeEventListener('scroll', handleScroll);
  }
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
      aria-label="Back to top"
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
