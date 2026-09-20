/** Stop waiting even if a provider ignores abort; observe its late rejection. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal);
  } finally {
    clearTimeout(timer);
  }
}
