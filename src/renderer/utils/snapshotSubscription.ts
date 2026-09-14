/** Subscribe before reading the baseline so transport changes cannot fall in a gap.
 * Patches received while the query is in flight are replayed after that baseline.
 */
export const subscribeWithSnapshot = <Snapshot, Message>(options: {
  read: () => Promise<Snapshot>;
  subscribe: (receive: (message: Message) => void) => () => void;
  applySnapshot: (snapshot: Snapshot) => void;
  applyMessage: (message: Message) => void;
}) => {
  let disposed = false;
  let initializing = true;
  const pending: Message[] = [];
  const unsubscribe = options.subscribe((message) => {
    if (disposed) return;
    if (initializing) pending.push(message);
    else options.applyMessage(message);
  });
  const ready = (async () => {
    try {
      const snapshot = await options.read();
      if (!disposed) options.applySnapshot(snapshot);
    } finally {
      initializing = false;
      if (!disposed) pending.forEach(options.applyMessage);
      pending.length = 0;
    }
  })();
  return {
    ready,
    dispose: () => {
      disposed = true;
      pending.length = 0;
      unsubscribe();
    },
  };
};
