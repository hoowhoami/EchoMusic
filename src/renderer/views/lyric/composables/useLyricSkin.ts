import { computed } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import { useSettingStore } from '@/stores/setting';
import type { LyricsSkinSettings } from '@/plugins/lyricsPage';

export interface LyricSkinHandle<T extends Record<string, unknown> = Record<string, unknown>> {
  key: Ref<string>;
  settings: ComputedRef<T>;
  patch: (patch: Partial<T>) => { ok: boolean; errors?: string[] };
  reset: () => void;
}

/**
 * 单个歌词页皮肤的配置句柄。
 * 配置按皮肤隔离存储在设置 store，宿主负责持久化，
 * 页面组件与设置组件共享同一实例，通过 inject(lyricsPageSkinKey) 提供。
 */
export function useLyricSkin<T extends Record<string, unknown> = Record<string, unknown>>(
  skinKey: string | Ref<string>,
  defaults: T,
  validate?: LyricsSkinSettings['validate'],
): LyricSkinHandle<T> {
  const settingStore = useSettingStore();
  const key = computed(() => (typeof skinKey === 'string' ? skinKey : skinKey.value));
  const settings = computed<T>(() => ({
    ...defaults,
    ...(settingStore.lyricsPageSkinConfigs[key.value] ?? {}),
  }));

  const patch = (patchData: Partial<T>): { ok: boolean; errors?: string[] } => {
    const next = { ...settings.value, ...patchData } as T;
    const result = validate ? validate(next) : true;
    if (result === false) return { ok: false, errors: ['配置校验失败'] };
    if (result && typeof result === 'object' && 'errors' in result) {
      const errors = (result as { errors?: string[] }).errors;
      if (errors?.length) return { ok: false, errors };
    }
    settingStore.patchLyricSkinConfig(key.value, next);
    return { ok: true };
  };

  const reset = () => settingStore.resetLyricSkinConfig(key.value);

  return { key, settings, patch, reset };
}
