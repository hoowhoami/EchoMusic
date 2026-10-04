import {
  computed,
  inject,
  onScopeDispose,
  provide,
  ref,
  watch,
  type InjectionKey,
  type Ref,
} from 'vue';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import {
  createWindowTransparencySync,
  windowBackgroundFromTransparency,
} from './windowTransparency';

interface WindowAppearance {
  frosted: Ref<boolean>;
  error: Ref<string>;
  setFrosted: (value: boolean) => void;
}
const key: InjectionKey<WindowAppearance> = Symbol('window-appearance');

export function provideWindowAppearance() {
  const theme = useThemeStore();
  const setting = useSettingStore();
  const frosted = computed(() => theme.activePreferences.windowFrosted === true);
  const error = ref('');
  const sync = createWindowTransparencySync(
    (value) => setting.setWindowBackground(value),
    (failure) => {
      error.value = failure ? '窗口效果未能应用，请重试' : '';
    },
  );
  const update = () =>
    sync.update(windowBackgroundFromTransparency(theme.windowTransparency, frosted.value));
  const setFrosted = (value: boolean) => {
    theme.updateGeneralPreferences({ windowFrosted: value });
  };
  watch([() => theme.windowTransparency, frosted], update, { immediate: true });
  onScopeDispose(() => sync.dispose());
  provide(key, { frosted, error, setFrosted });
}

export function useWindowAppearance() {
  const controls = inject(key);
  if (!controls) throw new Error('窗口外观控件必须位于主布局内');
  return controls;
}
