import { createDiscreteApi } from 'naive-ui';
import { useTheme } from './theme';
import { computed } from 'vue';

export function useNaiveDiscreteApi() {
  const { naiveTheme } = useTheme();
  const configProviderPropsRef = computed(() => {
    return {
      theme: naiveTheme.value,
    };
  });
  const { message, notification, dialog, loadingBar, modal } = createDiscreteApi(
    ['message', 'dialog', 'notification', 'loadingBar', 'modal'],
    {
      configProviderProps: configProviderPropsRef,
    },
  );
  return {
    message,
    dialog,
    notification,
    loadingBar,
    modal,
  };
}
