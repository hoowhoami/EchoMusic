import type { RouteLocationNormalizedLoaded, Router } from 'vue-router';
import { useToastStore } from '@/stores/toast';

const readSingleQueryValue = (value: unknown): string => {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0].trim() : '';
  return typeof value === 'string' ? value.trim() : '';
};

export const resolveCloseTarget = (
  route: Pick<RouteLocationNormalizedLoaded, 'query'>,
  fallback = '/main/home',
): string => {
  const from = readSingleQueryValue(route.query.from);
  return from || fallback;
};

export const closeTransientView = async (
  router: Router,
  route: Pick<RouteLocationNormalizedLoaded, 'query'>,
  fallback = '/main/home',
): Promise<void> => {
  const toastStore = useToastStore();
  try {
    await router.replace(resolveCloseTarget(route, fallback));
  } catch {
    toastStore.navigateFailed();
  }
};
