import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { buildDay, createFixtures, FIXTURE_TZ, listDays } from "../mock/fixtures";
import { dayInZone } from "../src/lib/zone";
import { installMock, renderApp } from "./helpers";

describe("days", () => {
  it("leads the home screen with today's digest and lists earlier days", async () => {
    const api = installMock({ signedIn: true });
    const user = userEvent.setup();
    renderApp("/");
    const today = await screen.findByRole("article", { name: /Pricing settled/ });
    expect(within(today).getByText("Launch date stays on the 4th")).toBeTruthy();
    expect(within(today).getAllByText("Mira").length).toBeGreaterThan(0);
    // Open tasks of the day are tickable in place.
    const task = within(today).getByRole("checkbox", {
      name: /Ask legal about the refund wording/,
    });
    await user.click(task);
    await waitFor(() =>
      expect(
        api.log.find(
          (r) => r.method === "PATCH" && r.path === "/conversations/conv-pricing/action-items/ai-2",
        )?.body,
      ).toEqual({
        done: true,
      }),
    );
    // Earlier days as cards; a day without a model says so.
    expect(screen.getByText("Onboarding plan for support, and lunch with Aylin")).toBeTruthy();
    expect(screen.getAllByText("Digest unavailable").length).toBeGreaterThan(0);
    expect(
      screen
        .getAllByRole("link", { name: /Timeline/ })
        .some((a) => a.getAttribute("href") === "/timeline"),
    ).toBe(true);
  });

  it("shows a day's digest sanitised, its status and a regenerate action", async () => {
    const api = installMock({ signedIn: true });
    const user = userEvent.setup();
    const date = dayInZone(api.fx.now, FIXTURE_TZ);
    renderApp(`/days/${date}`);
    expect(await screen.findByRole("heading", { level: 1, name: /Pricing settled/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Digest" })).toBeTruthy();
    expect(document.querySelector(".notes img")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Rewrite digest" }));
    await waitFor(() =>
      expect(
        api.log.some((r) => r.method === "POST" && r.path === `/days/${date}/regenerate`),
      ).toBe(true),
    );
    expect((await screen.findAllByText("Being written…")).length).toBeGreaterThan(0);
  });

  it("explains an unavailable digest and links to provider settings", async () => {
    const api = installMock({ signedIn: true });
    const unavailable = Object.entries(api.fx.digests).find(
      ([, d]) => d.status === "unavailable",
    )![0];
    renderApp(`/days/${unavailable}`);
    expect(await screen.findByText(/did not answer within 60 s/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Check AI provider settings" }).getAttribute("href"),
    ).toBe("/settings/providers");
  });

  it("derives day fixtures in the account's zone", () => {
    const fx = createFixtures();
    for (const date of listDays(fx)) {
      const d = buildDay(fx, date);
      for (const c of d.conversations) expect(dayInZone(c.startMs, FIXTURE_TZ)).toBe(date);
    }
  });

  it("shows a quiet today without asking for a day that has nothing captured", async () => {
    const api = installMock({ signedIn: true });
    const today = dayInZone(api.fx.now, FIXTURE_TZ);
    api.fx.conversations = api.fx.conversations.filter(
      (c) => dayInZone(c.startMs, FIXTURE_TZ) !== today,
    );
    api.fx.streams = [];
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "A quiet day so far" })).toBeTruthy();
    expect(screen.getByText("Onboarding plan for support, and lunch with Aylin")).toBeTruthy();
    expect(api.log.some((r) => r.path === `/days/${today}`)).toBe(false);
  });

  it("treats a day without captures (404) as an empty day, not an error", async () => {
    installMock({ signedIn: true });
    renderApp("/days/2026-01-05");
    expect(await screen.findByText("Nothing was captured on this day.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: /5 January/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Previous day/ }).getAttribute("href")).toBe(
      "/days/2026-01-04",
    );
    expect(document.querySelector(".note-error")).toBeNull();
  });
});
