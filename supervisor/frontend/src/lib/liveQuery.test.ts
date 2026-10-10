import { describe, expect, it } from "vitest";
import { LiveQuery } from "./liveQuery.svelte";

describe("adapted LiveQuery refresh timing", () => {
  it("prevents a superseded refresh from settling the current generation", () => {
    const query = new LiveQuery();
    const first = query.begin(10);
    const second = query.begin(20);
    const step = query.start("dashboard", 21);

    expect(query.isCurrent(first)).toBe(false);
    expect(query.isCurrent(second)).toBe(true);
    query.end(first);
    expect(query.startedAt).toBe(20);
    query.settle(step, { name: "dashboard", startMs: 1, durationMs: 12 });
    expect(query.steps).toEqual([{ name: "dashboard", startMs: 1, durationMs: 12 }]);
  });
});
