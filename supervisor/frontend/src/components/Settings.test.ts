import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import Settings from "./Settings.svelte";
import { makeState } from "../test/fixtures";

describe("operational settings", () => {
  it("exposes persisted policy limits and caps recovery at two", async () => {
    const dashboard = makeState({ settings: { interval: 300, max_concurrent: 4, global_concurrent: 12, max_recoveries: 2, backoff_seconds: 60, reserve: 5, allow_unknown_quota: false, allow_native: false, native_ceiling: 0, native_reserve: null, model_limits: {}, mode: "balanced", revision: 7 } });
    const onpolicy = vi.fn();
    render(Settings, { props: { dashboard, saving: false, notice: "", onsave: vi.fn(), onpolicy } });

    await fireEvent.click(screen.getByRole("button", { name: /Dispatch/ }));
    expect(screen.getByLabelText("Busy-worker stall threshold (seconds)")).toHaveValue(900);
    expect(screen.getByLabelText("Concurrent observation requests")).toHaveValue(4);
    expect(screen.getByLabelText("Provider request timeout (seconds)")).toHaveValue(20);
    expect(screen.getByLabelText("Maximum recoveries")).toHaveValue(2);
    expect(screen.getByLabelText("Allow native workers")).not.toBeChecked();
    expect(screen.getByText(/does not kill already-running remote workers/i)).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText("Project concurrency limit"), { target: { value: "6" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save operational policy" }));

    expect(onpolicy).toHaveBeenCalledWith(expect.objectContaining({ max_concurrent: 6, max_recoveries: 2, allow_native: false }), 7);
  });
});
