export const BLOCKED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const isBlockedObjectKey = (key: string) =>
  BLOCKED_OBJECT_KEYS.has(String(key).toLowerCase());
