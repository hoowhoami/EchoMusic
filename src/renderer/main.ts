import { createApp } from 'vue';
import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import { Icon } from '@iconify/vue';
import App from './App.vue';
import router from './router';
import { logger } from '@/utils/logger';
import './style.css';

const app = createApp(App);
const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);

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
  logger.error('App', 'Vue global exception catch', err, instance, info);
  void navigateToErrorPage(err, 'App Error');
};

window.addEventListener('error', (event) => {
  const errorMessage = event.error?.message ?? event.message ?? '';
  const filename = event.filename ?? '';

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
app.mount('#app');
