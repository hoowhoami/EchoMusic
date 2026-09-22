import {
  computed,
  onActivated,
  onDeactivated,
  onBeforeUnmount,
  shallowRef,
  watch,
  type WritableComputedRef,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getRouteViewCacheQuery } from '@/utils/routeViewCache';

type TabOptions = Record<string, readonly [string, ...string[]]>;

/**
 * 一个页面调用一次；第一项是默认值，多个 Tab 联动通过一次 select 更新。
 * 要求宿主像 MainLayout 一样按资源身份设置组件 key，不支持同一实例跨资源复用。
 */
export function useRouteTabs<const T extends TabOptions>(
  options: T,
  aliases: Partial<Record<keyof T, string>> = {},
) {
  const route = useRoute();
  const router = useRouter();
  const keys = Object.keys(options) as Array<keyof T & string>;
  const identity = () =>
    router.resolve({ path: route.path, query: getRouteViewCacheQuery(route), hash: route.hash })
      .fullPath;
  // 固定归属，防止路由已切换但尚未 deactivated 的旧实例读写新资源状态。
  const ownerIdentity = identity();
  const enabled = shallowRef(true);
  const isActive = computed(() => enabled.value && identity() === ownerIdentity);
  onActivated(() => {
    enabled.value = true;
  });
  onDeactivated(() => {
    enabled.value = false;
  });
  onBeforeUnmount(() => {
    enabled.value = false;
  });

  const read = (key: keyof T & string) => route.query[key] ?? route.query[aliases[key] ?? key];
  const readState = () =>
    Object.fromEntries(
      keys.map((key) => {
        const value = read(key);
        return [
          key,
          typeof value === 'string' && options[key].includes(value) ? value : options[key][0],
        ];
      }),
    ) as { [K in keyof T]: T[K][number] };
  const values = shallowRef(readState());
  watch(
    [isActive, ...keys.map((key) => () => read(key))],
    () => {
      if (isActive.value) values.value = readState();
    },
    { flush: 'sync' },
  );

  const select = async (patch: Partial<Record<keyof T, unknown>>) => {
    if (!isActive.value) return;
    const entries = Object.entries(patch);
    if (
      !entries.length ||
      entries.some(
        ([key, value]) =>
          !keys.includes(key) || typeof value !== 'string' || !options[key].includes(value),
      )
    )
      return;
    const query = { ...route.query };
    for (const [key, value] of entries) {
      if (aliases[key]) delete query[aliases[key]];
      query[key] = value as string;
    }
    // 交给 Router 处理重复/取消导航，包括快速切回原 Tab。
    await router.replace({ path: route.path, query, hash: route.hash });
  };
  const state = Object.fromEntries(
    keys.map((key) => [
      key,
      computed({
        get: () => values.value[key],
        set: (value: string) => {
          void select({ [key]: value } as Partial<Record<keyof T, unknown>>);
        },
      }),
    ]),
  ) as { [K in keyof T]: WritableComputedRef<T[K][number]> };
  return { state, select, isActive };
}
