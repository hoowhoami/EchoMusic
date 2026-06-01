export type AppLogLevel = 'error' | 'warn' | 'info' | 'debug' | 'verbose';

export type LogSettings = {
  level: AppLogLevel;
  apiResponseBody: boolean;
  diagnosticUntil: number;
};

export const DEFAULT_LOG_SETTINGS: LogSettings = {
  level: 'info',
  apiResponseBody: false,
  diagnosticUntil: 0,
};

const LEVEL_PRIORITY: Record<AppLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  verbose: 4,
};

const LOG_LEVELS = new Set<AppLogLevel>(['error', 'warn', 'info', 'debug', 'verbose']);

const SENSITIVE_KEY_PATTERN =
  /token|cookie|authorization|accesskey|dfid|mid|uuid|guid|dev|mac|password|secret|key/i;

const SENSITIVE_PAIR_PATTERN =
  /\b(token|accesskey|dfid|mid|KUGOU_API_MID|uuid|KUGOU_API_GUID|guid|KUGOU_API_DEV|KUGOU_API_MAC|Authorization|cookie)=([^;&\s]+)/gi;

export const normalizeLogSettings = (settings?: Partial<LogSettings> | null): LogSettings => {
  const level = LOG_LEVELS.has(settings?.level as AppLogLevel)
    ? (settings?.level as AppLogLevel)
    : DEFAULT_LOG_SETTINGS.level;

  return {
    level,
    apiResponseBody: Boolean(settings?.apiResponseBody),
    diagnosticUntil:
      typeof settings?.diagnosticUntil === 'number' && Number.isFinite(settings.diagnosticUntil)
        ? Math.max(0, settings.diagnosticUntil)
        : 0,
  };
};

export const isDiagnosticActive = (settings: LogSettings, now = Date.now()) =>
  settings.diagnosticUntil > now;

export const getEffectiveLogLevel = (settings: LogSettings, now = Date.now()): AppLogLevel => {
  if (isDiagnosticActive(settings, now) && LEVEL_PRIORITY[settings.level] < LEVEL_PRIORITY.debug) {
    return 'debug';
  }
  return settings.level;
};

export const isLogLevelEnabled = (targetLevel: AppLogLevel, currentLevel: AppLogLevel): boolean =>
  LEVEL_PRIORITY[targetLevel] <= LEVEL_PRIORITY[currentLevel];

export const maskSensitiveText = (value: string): string =>
  value.replace(SENSITIVE_PAIR_PATTERN, (_match, key: string, rawValue: string) => {
    if (!rawValue) return `${key}=`;
    if (rawValue.length <= 8) return `${key}=***`;
    return `${key}=${rawValue.slice(0, 4)}...${rawValue.slice(-4)}`;
  });

const maskString = (value: string): string => {
  if (!value) return value;
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

export const sanitizeForLog = (value: unknown, depth = 0): unknown => {
  if (value == null) return value;
  if (typeof value === 'string') return maskSensitiveText(value);
  if (typeof value !== 'object') return value;
  if (depth >= 4) return '[Object]';

  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeForLog(item, depth + 1));
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = typeof item === 'string' ? maskString(item) : '[REDACTED]';
    } else {
      result[key] = sanitizeForLog(item, depth + 1);
    }
  }
  return result;
};

export const stringifyForLog = (value: unknown, maxLength = 1200): string => {
  let text = '';
  try {
    text =
      typeof value === 'string' ? maskSensitiveText(value) : JSON.stringify(sanitizeForLog(value));
  } catch {
    text = String(value);
  }

  if (text.length > maxLength) {
    return `${text.slice(0, maxLength)}... (truncated, ${text.length} chars)`;
  }
  return text;
};

export const getPayloadSize = (value: unknown): number => {
  try {
    return typeof value === 'string' ? value.length : JSON.stringify(value).length;
  } catch {
    return 0;
  }
};
