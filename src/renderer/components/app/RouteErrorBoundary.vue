<script setup lang="ts">
import { computed, onErrorCaptured, ref, watch } from 'vue';
import { useRouter, type RouteLocationNormalizedLoaded } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import { iconTriangleAlert } from '@/icons';
import { logger } from '@/utils/logger';

const props = defineProps<{
  route: RouteLocationNormalizedLoaded;
}>();

const error = ref<unknown>(null);
const retryKey = ref(0);

const errorMessage = computed(() => {
  const current = error.value;
  if (current instanceof Error) return current.message || current.name;
  if (typeof current === 'string') return current;
  return '页面渲染时发生异常';
});

const errorDetailText = computed(() => {
  const current = error.value;
  if (current instanceof Error) {
    return [current.name, current.message, current.stack].filter(Boolean).join('\n');
  }
  if (typeof current === 'string') return current;
  try {
    return JSON.stringify(current, null, 2);
  } catch {
    return '无法序列化错误详情';
  }
});

const router = useRouter();

const getErrorSummary = (current: unknown) => {
  if (current instanceof Error) {
    return {
      name: current.name,
      message: current.message,
      stack: current.stack,
    };
  }
  if (typeof current === 'string') return { message: current };
  return { message: '页面渲染时发生异常' };
};

onErrorCaptured((capturedError, instance, info) => {
  error.value = capturedError;
  logger.error('RouteErrorBoundary', 'Captured route component error', {
    error: getErrorSummary(capturedError),
    component:
      typeof instance?.$?.type === 'object' &&
      instance.$.type &&
      'name' in instance.$.type &&
      typeof instance.$.type.name === 'string'
        ? instance.$.type.name
        : 'unknown',
    info,
  });
  return false;
});

watch(
  () => props.route.fullPath,
  () => {
    error.value = null;
    retryKey.value = 0;
  },
);

const retry = () => {
  error.value = null;
  retryKey.value += 1;
};

const goHome = () => {
  void router.replace('/main/home');
};
</script>

<template>
  <div class="route-error-boundary-root">
    <div v-if="error" class="route-error-boundary">
      <div class="route-error-card">
        <div class="route-error-icon">
          <Icon :icon="iconTriangleAlert" width="24" height="24" />
        </div>
        <div class="route-error-copy">
          <h2>当前页面暂时无法显示</h2>
          <p>{{ errorMessage }}</p>
        </div>
        <details class="route-error-details">
          <summary>查看错误详情</summary>
          <pre>{{ errorDetailText }}</pre>
        </details>
        <div class="route-error-actions">
          <Button variant="primary" size="sm" @click="retry">重试</Button>
          <Button variant="secondary" size="sm" @click="goHome">回到首页</Button>
        </div>
      </div>
    </div>
    <slot v-else :key="retryKey" />
  </div>
</template>

<style scoped>
.route-error-boundary-root {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.route-error-boundary {
  min-height: calc(100vh - 140px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
}

.route-error-card {
  width: min(560px, 100%);
  padding: 24px;
  border-radius: 26px;
  border: 1px solid var(--border-subtle);
  background: var(--color-bg-dialog);
  box-shadow: var(--shadow-dialog);
  backdrop-filter: var(--surface-backdrop-filter);
}

.route-error-icon {
  width: 54px;
  height: 54px;
  border-radius: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #d23d3d;
  background: color-mix(in srgb, #ef4444 12%, transparent);
}

.route-error-copy {
  margin-top: 18px;
}

.route-error-copy h2 {
  font-size: 20px;
  font-weight: 800;
  color: var(--color-text-main);
}

.route-error-copy p {
  margin-top: 8px;
  color: var(--color-text-secondary);
  line-height: 1.7;
  word-break: break-word;
}

.route-error-details {
  margin-top: 16px;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: var(--control-muted-bg);
  color: var(--color-text-secondary);
}

.route-error-details summary {
  padding: 10px 12px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  user-select: none;
}

.route-error-details pre {
  max-height: 220px;
  margin: 0;
  padding: 0 12px 12px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.route-error-actions {
  display: flex;
  gap: 10px;
  margin-top: 22px;
}
</style>
