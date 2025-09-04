import { useColorMode } from '@vueuse/core';
import { computed, watchEffect, InjectionKey, provide, inject } from 'vue';
import { darkTheme } from 'naive-ui';

// 用于全局注入的 Key
export const ThemeInjectionKey: InjectionKey<ReturnType<typeof useTheme>> = Symbol('theme');

export function useTheme() {
  // 初始化颜色模式管理
  const { system, store } = useColorMode({
    storageKey: 'app-theme-mode',
  });

  // 计算实际生效的主题模式
  const effectiveMode = computed(() => {
    return store.value === 'auto' ? system.value : store.value;
  });

  // 根据主题模式获取对应的 Ant Design 配置
  const naiveTheme = computed(() => {
    return effectiveMode.value === 'dark' ? darkTheme : null;
  });

  // 主题切换方法
  const switchTheme = (targetMode: 'light' | 'dark' | 'auto') => {
    store.value = targetMode;
  };

  // 快捷切换方法
  const setLightMode = () => switchTheme('light');
  const setDarkMode = () => switchTheme('dark');
  const setSystemMode = () => switchTheme('auto');

  // 监听主题变化，可用于添加自定义样式处理
  watchEffect(() => {
    // 添加全局类名用于自定义样式
    const html = document.documentElement;
    html.classList.toggle('theme-dark', effectiveMode.value === 'dark');
    html.classList.toggle('theme-light', effectiveMode.value === 'light');
  });

  return {
    // 当前模式（可能为 'auto'）
    store,
    // 实际生效的模式（'light' 或 'dark'）
    effectiveMode,
    // Naive UI 主题配置，用于传递给 ConfigProvider
    naiveTheme,
    // 切换到指定模式
    switchTheme,
    // 快捷方法
    setLightMode,
    setDarkMode,
    setSystemMode,
  };
}

// 提供全局主题
export function provideTheme() {
  const theme = useTheme();
  provide(ThemeInjectionKey, theme);
  return theme;
}

// 在组件中注入全局主题
export function useInjectTheme() {
  const theme = inject(ThemeInjectionKey);
  if (!theme) {
    throw new Error('请在应用根组件使用 provideTheme 提供主题');
  }
  return theme;
}
