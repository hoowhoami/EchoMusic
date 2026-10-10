type Dispose = () => void;

/** Owns subscriptions that may finish initializing after the app has unmounted. */
export function createAppLifetime() {
  let active = true;
  const disposers = new Set<Dispose>();
  return {
    get active() {
      return active;
    },
    add(dispose: Dispose | null | undefined) {
      if (!dispose) return;
      if (active) disposers.add(dispose);
      else dispose();
    },
    dispose() {
      if (!active) return;
      active = false;
      const pending = [...disposers];
      disposers.clear();
      const errors: unknown[] = [];
      for (const dispose of pending) {
        try {
          dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'App cleanup failed');
    },
  };
}

export type AppLifetime = ReturnType<typeof createAppLifetime>;
