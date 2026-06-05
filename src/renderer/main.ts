import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { Icon } from '@iconify/vue';
import type { ComponentPublicInstance } from 'vue';
import App from './App.vue';
import router from './router';
import { logger } from '@/utils/logger';
import { sqlitePersistPlugin } from '@/stores/sqlitePersist';
import { installPluginRuntime } from '@/plugins/runtime';
import './style.css';

const app = createApp(App);
const pinia = createPinia();
pinia.use(sqlitePersistPlugin);

const ERROR_REDIRECT_DEDUPE_MS = 1200;
let lastErrorSignature = '';
let lastErrorAt = 0;

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message || error.name || '发生了一些未知的错误';
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = Reflect.get(error, 'message');
    if (typeof message === 'string' && message.trim()) return message;
  }

  try {
    const serialized = JSON.stringify(error);
    return serialized === undefined ? '发生了一些未知的错误' : serialized;
  } catch {
    return String(error ?? '发生了一些未知的错误');
  }
};

const getErrorSummary = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: getErrorMessage(error),
  };
};

const getComponentSummary = (instance: ComponentPublicInstance | null): string => {
  if (!instance) return 'unknown';
  const type = instance.$?.type;
  if (typeof type === 'object' && type && 'name' in type && typeof type.name === 'string') {
    return type.name;
  }
  if (typeof type === 'object' && type && '__name' in type && typeof type.__name === 'string') {
    return type.__name;
  }
  return instance.$?.type ? 'anonymous-component' : 'unknown';
};

const hasPluginSource = (...sources: unknown[]) =>
  sources
    .filter((source) => source !== null && source !== undefined)
    .map((source) =>
      source instanceof Error ? `${source.message}\n${source.stack ?? ''}` : String(source),
    )
    .join('\n')
    .includes('echo-plugin:');

const shouldSkipErrorRedirect = (status: string, message: string, from: string): boolean => {
  const signature = `${status}|${message}|${from}`;
  const now = Date.now();
  if (signature === lastErrorSignature && now - lastErrorAt < ERROR_REDIRECT_DEDUPE_MS) {
    return true;
  }
  lastErrorSignature = signature;
  lastErrorAt = now;
  return false;
};

const navigateToErrorPage = async (error: unknown, status: string): Promise<void> => {
  const currentRoute = router.currentRoute.value;
  if (currentRoute.name === 'error') return;

  const message = getErrorMessage(error);
  const from = currentRoute.fullPath;
  if (shouldSkipErrorRedirect(status, message, from)) return;

  try {
    await router.replace({
      name: 'error',
      query: {
        message,
        status,
        from,
      },
    });
  } catch (navigationError) {
    logger.error('App', 'Failed to navigate to error page', navigationError);
  }
};

app.config.errorHandler = (err: unknown, instance, info) => {
  logger.error('App', 'Vue global exception catch', {
    error: getErrorSummary(err),
    component: getComponentSummary(instance),
    info,
  });
  void navigateToErrorPage(err, 'App Error');
};

window.addEventListener('error', (event) => {
  const errorMessage = event.error?.message ?? event.message ?? '';
  const filename = event.filename ?? '';
  if (hasPluginSource(event.error, event.message, filename)) {
    logger.warn('App', 'Plugin window error skipped by app boundary', errorMessage);
    return;
  }

  // Skip benign browser warnings that don't affect functionality
  const ignoredErrors = [
    'ResizeObserver loop completed with undelivered notifications',
    'ResizeObserver loop limit exceeded',
    'Non-Error promise rejection captured',
    'Script error.', // Cross-origin script errors
  ];

  // Skip errors from browser extensions
  const extensionPrefixes = ['chrome-extension://', 'moz-extension://', 'safari-extension://'];

  if (
    ignoredErrors.some((ignored) => errorMessage.includes(ignored)) ||
    extensionPrefixes.some((prefix) => filename.includes(prefix))
  ) {
    logger.warn('App', 'Ignored benign window error', errorMessage);
    return;
  }

  logger.error('App', 'Window error event', event.error ?? event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
  void navigateToErrorPage(event.error ?? event.message, 'Window Error');
});

window.addEventListener('unhandledrejection', (event) => {
  if (hasPluginSource(event.reason)) {
    logger.warn('App', 'Plugin promise rejection skipped by app boundary', event.reason);
    return;
  }
  logger.error('App', 'Unhandled promise rejection', event.reason);
  void navigateToErrorPage(event.reason, 'Unhandled Rejection');
});

router.onError((error) => {
  const errorMessage = error.message ?? '';

  // Skip benign router errors
  const ignoredRouterErrors = [
    'Navigation cancelled',
    'Avoided redundant navigation',
    'NavigationDuplicated',
  ];

  if (ignoredRouterErrors.some((ignored) => errorMessage.includes(ignored))) {
    logger.warn('App', 'Ignored benign router error', errorMessage);
    return;
  }

  logger.error('App', 'Router error', error);
  void navigateToErrorPage(error, 'Route Error');
});

app.use(pinia);
app.use(router);
app.component('Icon', Icon);
installPluginRuntime({ app, router, pinia });
app.mount('#app');
