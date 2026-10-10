import { describe, expect, it, vi } from "vitest";
import { SettledPoller } from "./settledPoller";

describe("SettledPoller", () => {
  it("coalesces refreshes and aborts a hung request before the next poll", async () => {
    let outstanding = 0;
    let maxOutstanding = 0;
    const errors: Error[] = [];
    const load = vi.fn((_signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      outstanding += 1;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      _signal.addEventListener("abort", () => {
        outstanding -= 1;
        reject(_signal.reason);
      }, { once: true });
    }));
    const poller = new SettledPoller(load, vi.fn(), (error) => errors.push(error), { intervalMs: 60_000, timeoutMs: 10 });

    const first = poller.refresh();
    expect(poller.refresh()).toBe(first);
    await first;

    expect(load).toHaveBeenCalledTimes(1);
    expect(maxOutstanding).toBe(1);
    expect(outstanding).toBe(0);
    expect(errors[0]?.message).toContain("timed out");
    poller.stop();
  });

  it("backs off after failures and returns to the normal interval after success", async () => {
    vi.useFakeTimers();
    try {
      const value = vi.fn();
      const error = vi.fn();
      let count = 0;
      const poller = new SettledPoller(async () => {
        count += 1;
        if (count === 1) throw new Error("offline");
        return "fresh";
      }, value, error, { intervalMs: 100, timeoutMs: 1_000, maxBackoffMs: 500 });
      poller.start();
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(200);
      expect(value).toHaveBeenCalledWith("fresh");
      poller.stop();
    } finally { vi.useRealTimers(); }
  });
});
