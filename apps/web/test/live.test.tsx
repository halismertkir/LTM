import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { installMock, renderApp } from "./helpers";

/** Minimal EventSource stand-in: tests push server events through `emit`. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: MessageEvent<string>) => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
  close() {}
}

describe("live events", () => {
  it("flips the capture state everywhere when another device pauses", async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    installMock({ signedIn: true });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Listening on 2 devices" })).toBeTruthy();
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("/api/v1/events");

    act(() => es.emit({ type: "capture_paused", ingestPaused: true }));
    expect(await screen.findByRole("heading", { name: "Capture is paused" })).toBeTruthy();
    expect(screen.getAllByText("Capture paused").length).toBeGreaterThan(0);

    act(() => es.emit({ type: "capture_paused", ingestPaused: false }));
    expect(await screen.findByRole("heading", { name: "Listening on 2 devices" })).toBeTruthy();
  });

  it("patches the days list when a day_updated event arrives", async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const api = installMock({ signedIn: true });
    renderApp("/");
    await screen.findByText("Onboarding plan for support, and lunch with Aylin");
    const date = Object.entries(api.fx.digests).find(([, d]) =>
      d.headline?.startsWith("Onboarding"),
    )![0];
    act(() =>
      FakeEventSource.instances[0]!.emit({
        type: "day_updated",
        day: {
          date,
          status: "ready",
          headline: "A rewritten headline for yesterday",
          summary: null,
          conversationCount: 2,
          speechMinutes: 58,
          openActionItems: 1,
          updatedAt: new Date().toISOString(),
        },
      }),
    );
    expect(await screen.findByText("A rewritten headline for yesterday")).toBeTruthy();
    expect(screen.queryByText("Onboarding plan for support, and lunch with Aylin")).toBeNull();
  });

  it("uses POST /capture/pause for the kill switch", async () => {
    const api = installMock({ signedIn: true });
    const user = userEvent.setup();
    renderApp("/");
    await screen.findByRole("heading", { name: "Listening on 2 devices" });
    await user.click(screen.getAllByRole("button", { name: /Pause capture/ })[0]!);
    await waitFor(() =>
      expect(api.log.find((r) => r.path === "/capture/pause")?.body).toEqual({ paused: true }),
    );
    expect(await screen.findByRole("heading", { name: "Capture is paused" })).toBeTruthy();
  });

  it("saves the UI language to the account when switched", async () => {
    const api = installMock({ signedIn: true });
    const user = userEvent.setup();
    renderApp("/");
    await screen.findByRole("heading", { level: 1, name: "Days" });
    await user.click(screen.getAllByRole("button", { name: "Switch language to Türkçe" })[0]!);
    expect(await screen.findByRole("heading", { level: 1, name: "Günler" })).toBeTruthy();
    await waitFor(() =>
      expect(api.log.find((r) => r.method === "PATCH" && r.path === "/me")?.body).toEqual({
        locale: "tr",
      }),
    );
    expect(localStorage.getItem("ltm.locale")).toBe("tr");
  });

  it("forgets this browser's capture credential on sign-out", async () => {
    installMock({ signedIn: true });
    localStorage.setItem(
      "ltm.listenDevice",
      JSON.stringify({ deviceId: "d", token: "t", name: "n" }),
    );
    const user = userEvent.setup();
    renderApp("/");
    await screen.findByRole("heading", { level: 1, name: "Days" });
    await user.click(screen.getAllByRole("button", { name: "Sign out" })[0]!);
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
    expect(localStorage.getItem("ltm.listenDevice")).toBeNull();
  });
});
