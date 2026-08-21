let fallbackNonceCounter = 0;

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export const createRendererSessionNonce = () => {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID().replace(/-/g, '');
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return toHex(bytes);
  }

  // Very old webviews may not expose Web Crypto. Keep the nonce unique within
  // the renderer process without relying on a predictable counter alone.
  fallbackNonceCounter += 1;
  return `${Date.now().toString(16)}${fallbackNonceCounter.toString(16)}${Math.random()
    .toString(16)
    .slice(2)}`
    .padEnd(32, '0')
    .slice(0, 32);
};

export const createRendererSessionId = (prefix: string, nonce: string, sequence: number) =>
  `${prefix}:${nonce}:${sequence}`;
