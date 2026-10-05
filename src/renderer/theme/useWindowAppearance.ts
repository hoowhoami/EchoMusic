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
  frostedKeepOnBlur: Ref<boolean>;
  error: Ref<string>;
  setFrosted: (value: boolean) => void;
  setFrostedKeepOnBlur: (value: boolean) => void;
}
const key: InjectionKey<WindowAppearance> = Symbol('window-appearance');

export function provideWindowAppearance() {
  const theme = useThemeStore();
  const setting = useSettingStore();
  const frosted = computed(() => theme.activePreferences.windowFrosted === true);
  const frostedKeepOnBlur = computed(
    () => theme.activePreferences.windowFrostedKeepOnBlur === true,
  );
  const error = ref('');
  const sync = createWindowTransparencySync(
    (value) => setting.setWindowBackground(value),
    (failure) => {
      error.value = failure ? '窗口效果未能应用，请重试' : '';
    },
  );
  const update = () =>
    sync.update(
      windowBackgroundFromTransparency(
        theme.windowTransparency,
        frosted.value,
        frostedKeepOnBlur.value,
      ),
    );
  const setFrosted = (value: boolean) => {
    theme.updateGeneralPreferences({ windowFrosted: value });
  };
  const setFrostedKeepOnBlur = (value: boolean) => {
    theme.updateGeneralPreferences({ windowFrostedKeepOnBlur: value });
  };
  watch([() => theme.windowTransparency, frosted, frostedKeepOnBlur], update, { immediate: true });
  onScopeDispose(() => sync.dispose());
  provide(key, { frosted, frostedKeepOnBlur, error, setFrosted, setFrostedKeepOnBlur });
}

export function useWindowAppearance() {
  const controls = inject(key);
  if (!controls) throw new Error('窗口外观控件必须位于主布局内');
  return controls;
}
