import { CONSENT_DOCUMENTS } from "@ltm/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { installMock, renderApp } from "./helpers";

describe("consent gate", () => {
  it("blocks the timeline until every required document is explicitly accepted", async () => {
    const api = installMock(); // signed in? no: start signed out with an existing owner
    api.session = true;
    const user = userEvent.setup();
    renderApp("/");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Before LTM listens" }),
    ).toBeTruthy();
    // The timeline is not rendered behind the gate.
    expect(screen.queryByRole("heading", { name: "Days", level: 1 })).toBeNull();
    // Capture state says "blocked" everywhere.
    expect(screen.getAllByText("Capture blocked").length).toBeGreaterThan(0);

    const required = CONSENT_DOCUMENTS.filter((d) => d.requiredWhen === "always");
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(required.length);
    for (const b of boxes) expect((b as HTMLInputElement).checked).toBe(false);
    // Canonical document titles and body text are rendered as-is.
    for (const d of required) {
      expect(screen.getByRole("heading", { name: d.en.title })).toBeTruthy();
    }
    expect(screen.getByText(/In many places it is illegal to record a conversation/)).toBeTruthy();

    const submit = screen.getByRole("button", { name: /Accept and allow capture/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.click(boxes[0]!);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.click(boxes[1]!);
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    await user.click(submit);

    expect(await screen.findByRole("heading", { level: 1, name: "Days" })).toBeTruthy();
    const post = api.log.find((r) => r.method === "POST" && r.path === "/consents");
    expect(post?.body).toEqual({
      accept: required.map((d) => ({ type: d.type, version: d.version })),
    });
  });

  it("keeps settings reachable while consent is missing and says capture is blocked", async () => {
    const api = installMock();
    api.session = true;
    renderApp("/settings/privacy");
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    const banner = await screen.findByText(
      /Capture is blocked until you accept the consent documents\. You can look around/,
    );
    expect(banner).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Consent" })).toBeTruthy());
    const consentSection = screen.getByRole("heading", { name: "Consent" }).closest("section")!;
    expect(within(consentSection).getAllByText("not accepted").length).toBe(2);
  });

  it("asks for third-party consent once an external provider is configured", async () => {
    const api = installMock({ signedIn: true });
    api.fx.settings.providers.llm = {
      ...api.fx.settings.providers.llm,
      kind: "anthropic",
      thirdParty: true,
      hasApiKey: true,
    };
    renderApp("/");
    expect(
      await screen.findByRole("heading", { name: "Sending content to an external AI provider" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });
});
