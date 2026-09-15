// Keep one in-flight command and only the newest pending value. Stale failures
// must not roll back a more recent user selection.
export function createLatestRequestQueue<T>(handlers: {
  apply: (value: T) => Promise<void>;
  applied: (value: T) => Promise<void>;
  failed: (value: T, error: unknown) => void;
  report: (error: unknown) => void;
}) {
  let revision = 0;
  let pending: { value: T; revision: number } | undefined;
  let running = false;
  const run = async () => {
    try {
      while (pending) {
        const job = pending;
        pending = undefined;
        try {
          await handlers.apply(job.value);
        } catch (error) {
          if (job.revision === revision) {
            try {
              handlers.failed(job.value, error);
            } catch (failure) {
              handlers.report(failure);
            }
          }
          continue;
        }
        if (job.revision === revision) {
          // A diagnostics refresh failure is not an audio-engine failure.
          try {
            await handlers.applied(job.value);
          } catch (error) {
            handlers.report(error);
          }
        }
      }
    } finally {
      running = false;
    }
  };
  return {
    enqueue(value: T) {
      pending = { value, revision: ++revision };
      if (!running) {
        running = true;
        void run().catch(handlers.report);
      }
    },
  };
}
