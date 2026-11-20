import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFixtures, FIXTURE_TZ } from "../mock/fixtures";
import { dayInZone } from "../src/lib/zone";
import { ConversationCard, groupByDay } from "../src/pages/Timeline";
import { installMock, renderApp, renderWithProviders } from "./helpers";

describe("timeline", () => {
  it("renders fixture conversations grouped by day, newest first", async () => {
    installMock({ signedIn: true });
    renderApp("/timeline");

    expect(
      await screen.findByRole("heading", { level: 3, name: "Pricing review with the design team" }),
    ).toBeTruthy();
    const dayHeadings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(dayHeadings).toEqual(expect.arrayContaining(["Today", "Yesterday"]));
    expect(dayHeadings.indexOf("Today")).toBeLessThan(dayHeadings.indexOf("Yesterday"));

    // An open conversation with interim notes shows them, marked as provisional.
    const live = screen
      .getByRole("heading", { level: 3, name: "Weekly product sync: roadmap and hiring" })
      .closest("article")!;
    expect(within(live).getByText("Live · notes so far")).toBeTruthy();
    // Placeholder title while a conversation is being processed.
    expect(screen.getByRole("heading", { level: 3, name: "Writing notes…" })).toBeTruthy();

    const card = screen
      .getByRole("heading", { name: "Pricing review with the design team" })
      .closest("article")!;
    expect(within(card).getByText("2 open tasks")).toBeTruthy();
    expect(within(card).getByText("pricing")).toBeTruthy();
    expect(within(card).getByText(/47 min/)).toBeTruthy();
    expect(within(card).getByRole("link").getAttribute("href")).toBe("/conversations/conv-pricing");

    expect(screen.getAllByText("Transcript only").length).toBeGreaterThan(0);
    // The live strip reports the active streams from /streams.
    expect(await screen.findByRole("heading", { name: "Listening on 2 devices" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Pause capture/ }).length).toBeGreaterThan(0);
  });

  it("shows a placeholder title for an open conversation without notes yet", async () => {
    installMock({ signedIn: true });
    const c = { ...createFixtures().conversations[0]!, title: null, summary: null, interim: false };
    renderWithProviders(<ConversationCard c={c} devices={new Map()} />);
    expect(await screen.findByRole("heading", { name: /^Listening since/ })).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("explains how to pair a first device when there is nothing yet", async () => {
    const api = installMock({ signedIn: true });
    api.fx.conversations = [];
    api.fx.streams = [];
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Your notebook is empty" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Pair a device" }).getAttribute("href")).toBe(
      "/devices?pair=1",
    );
  });

  it("groups by day in the account's zone", () => {
    const fx = createFixtures();
    const groups = groupByDay(fx.conversations, FIXTURE_TZ);
    for (const g of groups)
      for (const c of g.items) expect(dayInZone(c.startMs, FIXTURE_TZ)).toBe(g.day);
    const starts = groups.flatMap((g) => g.items.map((c) => c.startMs));
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
  });
});
