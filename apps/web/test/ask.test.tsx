import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { installMock, renderApp } from "./helpers";

describe("ask thread", () => {
  it("stacks questions and answers with per-answer sources and a scope", async () => {
    const api = installMock({ signedIn: true });
    const user = userEvent.setup();
    renderApp("/ask");
    const box = await screen.findByLabelText("Your question");
    await user.click(screen.getByRole("radio", { name: "Last 7 days" }));
    await user.type(box, "When is the launch?");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    const thread = await screen.findByRole("list", { name: "Questions and answers" });
    await within(thread).findByText(/planned for/);
    const first = api.log.find((r) => r.path === "/ask")!.body as {
      question: string;
      from?: number;
      to?: number;
    };
    expect(first.question).toBe("When is the launch?");
    expect(typeof first.from).toBe("number");

    await user.type(box, "And who owns the table?");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() =>
      expect(within(thread).getAllByRole("listitem", { name: undefined }).length).toBeGreaterThan(
        1,
      ),
    );
    const turns = thread.querySelectorAll(":scope > li");
    expect(turns).toHaveLength(2);
    expect(turns[1]!.textContent).toContain("And who owns the table?");
    // Sources are per answer and collapsed until asked for.
    const details = turns[0]!.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(within(turns[0] as HTMLElement).getByText("3 sources")).toBeTruthy();
    expect(turns[0]!.querySelector('a[href^="#cite-t1-"]')).toBeTruthy();
    expect(turns[1]!.querySelector('a[href^="#cite-t2-"]')).toBeTruthy();
  });

  it("runs a question sent from the sidebar box", async () => {
    const api = installMock({ signedIn: true });
    const user = userEvent.setup();
    renderApp("/");
    const box = (await screen.findAllByLabelText("Ask your memory"))[0]!;
    await user.type(box, "What did I promise?{Enter}");
    await screen.findByRole("list", { name: "Questions and answers" });
    await waitFor(() => expect(api.log.filter((r) => r.path === "/ask")).toHaveLength(1));
    expect(window.location.pathname).toBe("/ask");
    expect(window.location.search).toBe("");
  });

  it("points to provider settings when no language model is configured", async () => {
    const api = installMock({ signedIn: true });
    api.fx.settings.providers.llm = { ...api.fx.settings.providers.llm, kind: "none" };
    const user = userEvent.setup();
    renderApp("/ask");
    await user.type(await screen.findByLabelText("Your question"), "Anything?");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("No language model is configured.")).toBeTruthy();
  });
});
