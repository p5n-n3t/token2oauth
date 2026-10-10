import { describe, expect, it, vi } from "vitest";
import { getHistory, postControl } from "./api";

describe("future control client", () => {
  it("uses state/reason receipts and preserves HTTP rejection metadata", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ action_id: "act-1", state: "rejected", reason: "Stale revision", revision: 9, status_code: 409 }),
    });

    const receipt = await postControl(
      { action: "resume", target_id: "task-1", values: {}, expected_revision: 8 },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v2/control",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
    expect(receipt.state).toBe("rejected");
    expect(receipt.reason).toBe("Stale revision");
    expect(receipt.status_code).toBe(409);
  });

  it("retains pending truth from an HTTP 202 receipt", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 202, json: async () => ({ action_id: "act-2", state: "pending", reason: "Awaiting provider acknowledgment.", revision: 4, status_code: 202 }) });
    const receipt = await postControl({ action: "cancel", target_id: "task-1", values: {}, expected_revision: 3 }, fetcher);
    expect(receipt).toMatchObject({ state: "pending", reason: "Awaiting provider acknowledgment.", status_code: 202 });
  });
});

describe("bounded history API", () => {
  it("requests one server page and returns its server total", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [{ id: "event-1", at: 42, kind: "completed", title: "Finished run", detail: "Recorded", task_id: "done-1" }],
        total: 10_000, offset: 25, limit: 25, has_more: true,
      }),
    });

    const history = await getHistory({ offset: 25, limit: 25, query: "Finished run" }, fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v2/history/events?offset=25&limit=25&q=Finished+run",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(history).toMatchObject({ total: 10_000, offset: 25, limit: 25, has_more: true });
    expect(history.entries).toHaveLength(1);
  });
});
