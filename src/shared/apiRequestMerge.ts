const AUTH_REQUEST_FIELDS = new Set([
  'cookie',
  'token',
  'userid',
  't1',
  'dfid',
  'mid',
  'uuid',
  'guid',
  'mac',
  'dev',
  'kugou_api_mid',
  'kugou_api_guid',
  'kugou_api_mac',
  'kugou_api_dev',
  'kugou_api_platform',
  'kugou_api_webgl',
]);

export const isAuthenticationRequestField = (key: string) =>
  AUTH_REQUEST_FIELDS.has(String(key).toLowerCase());

export const isBlockedRequestBodyField = (key: string) =>
  isAuthenticationRequestField(key) || isBlockedObjectKey(key);

export const mergeApiRequestBody = <T extends Record<string, unknown>>(
  query: T,
  body: Record<string, unknown>,
): T => {
  const mutableQuery = query as Record<string, unknown>;
  for (const [key, value] of Object.entries(body)) {
    if (isBlockedRequestBodyField(key)) continue;
    Object.defineProperty(mutableQuery, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return query;
};
import { isBlockedObjectKey } from './objectSafety';
