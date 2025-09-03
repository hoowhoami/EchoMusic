import naive, { createDiscreteApi } from 'naive-ui';
import { useTheme } from '@/hooks';
import { App, computed } from 'vue';

export function setupNaive(app: App<Element>) {
  // 注册 naive-ui
  app.use(naive);

  const { naiveTheme } = useTheme();
  const configProviderPropsRef = computed(() => {
    return {
      theme: naiveTheme.value,
    };
  });
  // 注册 naive-ui 的离散 API
  const { message, notification, dialog, loadingBar, modal } = createDiscreteApi(
    ['message', 'dialog', 'notification', 'loadingBar', 'modal'],
    {
      configProviderProps: configProviderPropsRef,
      messageProviderProps: {
        max: 3,
      },
    },
  );
  // 挂在到window
  window.$loadingBar = loadingBar;
  window.$notification = notification;
  window.$message = message;
  window.$dialog = dialog;
  window.$modal = modal;
}
