import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import History from "./History.svelte";
import { makeHistory } from "../test/fixtures";

describe("History", () => {
  it("renders a bounded server page and asks the server for the next page", async () => {
    const onpage = vi.fn();
    const onsearch = vi.fn();
    render(History, { props: { entries: makeHistory(25), total: 10_000, offset: 0, limit: 25, query: "", loading: false, error: "", onpage, onsearch } });

    expect(screen.getAllByTestId("history-row")).toHaveLength(25);
    expect(screen.getByText("Showing 1–25 of 10,000 records")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onpage).toHaveBeenCalledWith(25);
    expect(screen.getAllByTestId("history-row")).toHaveLength(25);
    await fireEvent.input(screen.getByRole("searchbox", { name: "Search history" }), { target: { value: "critical" } });
    expect(onsearch).toHaveBeenCalledWith("critical");
  });
});
