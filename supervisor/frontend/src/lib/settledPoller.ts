/** A recursive poller that never starts the next request until the previous one settles. */
export class SettledPoller<T> {
  private inFlight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private failures = 0;

  constructor(
    private readonly load: (signal: AbortSignal) => Promise<T>,
    private readonly onvalue: (value: T) => void,
    private readonly onerror: (error: Error) => void,
    private readonly options: { intervalMs?: number; timeoutMs?: number; maxBackoffMs?: number } = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.stopped) this.stopped = false;
    if (this.inFlight) return this.inFlight;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    const timeoutMs = this.options.timeoutMs ?? 8_000;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("State request timed out."));
    }, timeoutMs);

    const request = this.load(controller.signal)
      .then((value) => {
        if (!this.stopped) {
          this.failures = 0;
          this.onvalue(value);
        }
      })
      .catch((error: unknown) => {
        if (!this.stopped) {
          this.failures += 1;
          this.onerror(timedOut ? new Error("State request timed out.") : error instanceof Error ? error : new Error("The state request failed."));
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        this.controller = null;
        this.inFlight = null;
        if (!this.stopped) this.schedule();
      });
    this.inFlight = request;
    return request;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort(new Error("State polling stopped."));
  }

  private schedule(): void {
    const interval = this.options.intervalMs ?? 10_000;
    const max = this.options.maxBackoffMs ?? 120_000;
    const delay = this.failures ? Math.min(interval * 2 ** Math.min(this.failures, 8), max) : interval;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delay);
  }
}
