/** Mutation notifications avoid making cached consumers poll the synchronous native store. */
type KvChange = { key: string; value?: unknown } | { reset: true };
const listeners = new Set<(change: KvChange) => void>();

export const onKvChange = (listener: (change: KvChange) => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const notifyKvChange = (change: KvChange) => {
  for (const listener of listeners) listener(change);
};
