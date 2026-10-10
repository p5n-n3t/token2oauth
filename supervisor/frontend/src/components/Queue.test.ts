import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import Queue from "./Queue.svelte";
import { makeSlot, makeState } from "../test/fixtures";

const callbacks = { onpage: vi.fn(), oninspect: vi.fn(), oncontrol: vi.fn() };

describe("Queue controls", () => {
  it("renders only its bounded task page and explains ownership gates", () => {
    const active = { id: "task-active", project: "trump-files", state: "running", priority: 1, revision: 4, summary: "Active task", approved: true };
    const draft = { id: "task-draft", project: "trump-files", state: "draft", priority: 0, revision: 0, summary: "Draft task", approved: false };
    render(Queue, {
      props: {
        dashboard: makeState({ slots: [makeSlot({ task_id: "task-active", task_state: "running" })] }),
        tasks: [active, draft], total: 10_000, offset: 0, limit: 50, loading: false, error: "", ...callbacks,
      },
    });

    expect(screen.getAllByTestId("queue-row")).toHaveLength(2);
    expect(screen.getByText("Showing 1–2 of 10,000 tasks")).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Reassign" })) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", expect.stringContaining("not supported"));
    }
    expect(screen.getAllByRole("button", { name: "Retry" }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getAllByRole("button", { name: "Cancel" }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("does not imply that a command-like draft form runs a shell", () => {
    render(Queue, {
      props: { dashboard: makeState(), tasks: [], total: 0, offset: 0, limit: 50, loading: false, error: "", ...callbacks },
    });
    expect(screen.getByRole("button", { name: "Add task draft" })).toBeInTheDocument();
  });

  it("makes a paused retry an explicit one-time override", async () => {
    const oncontrol = vi.fn();
    const task = { id: "task-held", project: "trump-files", state: "held", priority: 0, revision: 5, summary: "Held task", approved: true };
    render(Queue, {
      props: {
        dashboard: makeState({
          slots: [], settings: { interval: 300, pause_dispatch: true, emergency_stop: false },
          capabilities: { dispatch: { supported: true, reason: null } },
        }),
        tasks: [task], total: 1, offset: 0, limit: 50, loading: false, error: "", ...callbacks, oncontrol,
      },
    });

    await fireEvent.click(screen.getAllByRole("button", { name: "Retry once" })[0]);
    expect(oncontrol).toHaveBeenCalledWith("retry", "task-held", { override_pause: true }, 5);
  });
});
