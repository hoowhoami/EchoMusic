export const sanitizePluginNetworkLogUrl = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value);
    const search = url.search ? '?[redacted]' : '';
    const hash = url.hash ? '#[redacted]' : '';
    return `${url.protocol}//${url.host}${url.pathname}${search}${hash}`;
  } catch {
    return '[invalid-url]';
  }
};
