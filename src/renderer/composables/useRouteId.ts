import { ref, onMounted, onActivated, type Ref } from 'vue';
import { useRoute } from 'vue-router';

/**
 * KeepAlive 安全的路由 id 管理
 *
 * - onMounted: 首次加载
 * - onActivated: KeepAlive 恢复时检查 id 是否变化
 */
export function useRouteId(paramName = 'id') {
  const route = useRoute();
  const id = ref('') as Ref<string>;
  const callbacks: Array<(newId: string) => void> = [];

  const resolveId = () => {
    const raw = route.params[paramName];
    return String(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''));
  };

  const onIdChange = (cb: (newId: string) => void) => {
    callbacks.push(cb);
  };

  onMounted(() => {
    id.value = resolveId();
  });

  // KeepAlive 恢复时检查
  onActivated(() => {
    const newId = resolveId();
    if (newId && newId !== id.value) {
      id.value = newId;
      callbacks.forEach((cb) => cb(newId));
    }
  });

  return { id, onIdChange };
}
