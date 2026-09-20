/** FIFO ownership of the non-overlay editor slot, local to one extension instance.
 * Cancellation of an active question must close its UI, not merely abandon the
 * waiter. Keep ownership until the actual UI promise settles. */
export function createQuestionQueue() {
  interface Request {
    start(): void;
    cancel(): void;
    finished: Promise<void>;
  }
  const pending: Request[] = [];
  let active: Request | undefined;
  let closed = false;

  function pump() {
    if (closed || active) return;
    active = pending.shift();
    active?.start();
  }

  return {
    run<T>(show: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
      if (closed || signal?.aborted) return Promise.resolve(undefined);
      return new Promise<T | undefined>((resolve, reject) => {
        const controller = new AbortController();
        let started = false;
        let completed = false;
        let finish!: () => void;
        const finished = new Promise<void>((done) => { finish = done; });
        const cleanup = () => signal?.removeEventListener("abort", request.cancel);
        const request: Request = {
          finished,
          cancel() {
            if (completed) return;
            controller.abort();
            if (!started) {
              const index = pending.indexOf(request);
              if (index >= 0) pending.splice(index, 1);
              completed = true;
              cleanup();
              resolve(undefined);
              finish();
            }
          },
          start() {
            started = true;
            void (async () => {
              try {
                if (closed || controller.signal.aborted) {
                  resolve(undefined);
                  return;
                }
                const result = await show(controller.signal);
                resolve(controller.signal.aborted ? undefined : result);
              } catch (error) {
                reject(error);
              } finally {
                completed = true;
                cleanup();
                active = undefined;
                finish();
                // Let the completed UI's stack unwind before opening another.
                queueMicrotask(pump);
              }
            })();
          },
        };
        signal?.addEventListener("abort", request.cancel, { once: true });
        pending.push(request);
        if (signal?.aborted) request.cancel();
        pump();
      });
    },
    /** Idempotent; cancel queued work immediately, then await active UI cleanup. */
    close(): Promise<void> {
      closed = true;
      const current = active;
      for (const request of [...pending]) request.cancel();
      current?.cancel();
      return current?.finished ?? Promise.resolve();
    },
  };
}
