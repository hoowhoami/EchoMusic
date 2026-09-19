const ABORT_NAMES = new Set(['AbortError', 'CanceledError']);
const ABORT_CODES = new Set(['ERR_CANCELED', 'ERR_ABORTED', 'ABORT_ERR']);
const ABORT_MESSAGES = [
  'the user aborted a request',
  'the operation was aborted',
  'this operation was aborted',
  'aborted a request',
];

const readErrorField = (error: unknown, key: string): unknown => {
  if (!error || typeof error !== 'object') return undefined;
  return Reflect.get(error, key);
};

const readErrorMessage = (error: unknown): string => {
  if (typeof error === 'string') return error.trim();
  const message = readErrorField(error, 'message');
  if (typeof message === 'string') return message.trim();
  if (error instanceof Error) return error.message.trim();
  return '';
};

/**
 * Chromium fetch, Axios, and DOM AbortSignal cancellations. These are expected
 * when a page is hidden, a request is superseded, or the user navigates away.
 */
export const isAbortError = (error: unknown): boolean => {
  if (error == null) return false;

  const name = readErrorField(error, 'name');
  if (typeof name === 'string' && name === 'TimeoutError') return false;
  if (typeof name === 'string' && ABORT_NAMES.has(name)) return true;

  const code = readErrorField(error, 'code');
  if (typeof code === 'string' && ABORT_CODES.has(code)) return true;

  if (readErrorField(error, '__CANCEL__') === true) return true;

  const message = readErrorMessage(error).toLowerCase();
  if (!message) return false;
  if (message.includes('timeout')) return false;
  if (message === 'canceled' || message === 'cancelled') return true;
  return ABORT_MESSAGES.some((pattern) => message.includes(pattern));
};
