import { ref, onMounted, onActivated, type Ref } from 'vue';
import { useRoute, onBeforeRouteUpdate } from 'vue-router';

/**
 * KeepAlive 安全的路由 id 管理
 *
 * - onMounted: 首次加载
 * - onBeforeRouteUpdate: 同路由内参数变化（如歌手A→歌手B），天然不受其他路由干扰
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

  // 同路由内参数变化，只在当前路由生效
  onBeforeRouteUpdate((to) => {
    const raw = to.params[paramName];
    const newId = String(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''));
    if (newId && newId !== id.value) {
      id.value = newId;
      callbacks.forEach((cb) => cb(newId));
    }
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
