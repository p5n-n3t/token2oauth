import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import TaskDrawer from "./TaskDrawer.svelte";

describe("TaskDrawer", () => {
  it("renders assigned text literally and filters unsafe evidence links", () => {
    render(TaskDrawer, {
      props: {
        open: true,
        detail: {
          task_id: "task-unsafe",
          summary: "Inspect output",
          instruction: '<img src=x onerror="alert(1)"> literal prompt',
          state: "running",
          attempts: [{generation:1,state:"blocked"}],
          events: [{kind:"validation_failed",data:{reason:"Missing output ID"}}],
          references: ["javascript:alert(1)", "https://user:secret@example.test/private", "https://docs.example.test/runbook"],
        },
        slot: null,
        onclose: () => undefined,
      },
    });

    expect(screen.getByText(/<img src=x onerror=/)).toBeInTheDocument();
    expect(document.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://docs.example.test/runbook");
    expect(screen.getByText(/Missing output ID/)).toBeInTheDocument();
  });
});
