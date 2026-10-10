import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import Providers from "./Providers.svelte";
import { makeState } from "../test/fixtures";

describe("Providers controls", () => {
  it("keeps identity and credential evidence unknown until the server reports it", () => {
    render(Providers, { props: { dashboard: makeState() } });

    expect(screen.getByText("Credential status").parentElement).toHaveTextContent("Not reported");
    expect(screen.getByText("Identity not reported")).toBeInTheDocument();
    expect(screen.queryByText("Stored by local runtime")).not.toBeInTheDocument();
  });

  it("submits only public account configuration with the account revision", async () => {
    const oncontrol = vi.fn();
    render(Providers, { props: { dashboard: makeState(), oncontrol } });

    await fireEvent.click(screen.getByRole("button", { name: "Edit account" }));
    await fireEvent.input(screen.getByLabelText("Models"), { target: { value: "gpt-5, codex-5" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save account" }));

    expect(oncontrol).toHaveBeenCalledWith("account-config", "night-shift", expect.objectContaining({ models: ["gpt-5", "codex-5"] }), 0);
  });
});
