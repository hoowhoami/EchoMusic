const STORE_PERSISTENCE_NAMESPACE = 'pinia';

export type StorePersistenceKey = `${typeof STORE_PERSISTENCE_NAMESPACE}:${string}`;

/**
 * Keep the persisted Pinia key format in one place so callers do not depend on
 * the storage namespace or assemble keys themselves.
 */
export const getStorePersistenceKey = (storeId: string): StorePersistenceKey =>
  `${STORE_PERSISTENCE_NAMESPACE}:${storeId}`;
