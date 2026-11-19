import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ProvidersSettings } from "../src/pages/settings/Providers";
import { installMock, renderWithProviders } from "./helpers";
import { MeGate } from "./me-gate";

const SECRET = "sk-test-0123456789-very-secret";

function sttCard() {
  return screen.getByRole("heading", { name: "Speech to text" }).closest("section") as HTMLElement;
}

describe("provider form", () => {
  it("never pre-fills or echoes a stored API key", async () => {
    const api = installMock({ signedIn: true });
    api.fx.settings.providers.stt = {
      role: "stt",
      kind: "openai",
      model: null,
      baseUrl: null,
      hasApiKey: true,
      origin: "user",
      thirdParty: true,
    };
    api.acceptAllRequired();
    const user = userEvent.setup();
    renderWithProviders(
      <MeGate>
        <ProvidersSettings />
      </MeGate>,
      "/settings/providers",
    );

    await screen.findByRole("heading", { name: "Speech to text" });
    const card = sttCard();
    expect(within(card).getByText("Key saved")).toBeTruthy();
    // No key input is shown at all while the saved key is kept.
    expect(card.querySelector('input[type="password"]')).toBeNull();

    await user.click(within(card).getByRole("button", { name: "Replace key" }));
    const input = within(card).getByLabelText(/^API key/) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    expect(input.autocomplete).toBe("off");

    await user.type(input, SECRET);
    await user.click(within(card).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const put = api.log.find((r) => r.method === "PUT" && r.path === "/settings/providers/stt");
      expect(put?.body).toMatchObject({ kind: "openai", apiKey: SECRET });
    });
    // After saving, the key is gone from the DOM and the card is back to "Key saved".
    await waitFor(() => expect(within(sttCard()).getByText("Key saved")).toBeTruthy());
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("omits apiKey when the key is untouched and sends null when it is removed", async () => {
    const api = installMock({ signedIn: true });
    api.fx.settings.providers.stt = {
      role: "stt",
      kind: "openai",
      model: null,
      baseUrl: null,
      hasApiKey: true,
      origin: "user",
      thirdParty: true,
    };
    api.acceptAllRequired();
    const user = userEvent.setup();
    renderWithProviders(
      <MeGate>
        <ProvidersSettings />
      </MeGate>,
      "/settings/providers",
    );
    await screen.findByRole("heading", { name: "Speech to text" });

    await user.type(within(sttCard()).getByLabelText("Model"), "whisper-1");
    await user.click(within(sttCard()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.log.some((r) => r.method === "PUT")).toBe(true));
    const first = api.log.filter((r) => r.method === "PUT").at(-1)!.body as Record<string, unknown>;
    expect(first).toEqual({ kind: "openai", model: "whisper-1", baseUrl: null });
    expect("apiKey" in first).toBe(false);

    await waitFor(() => within(sttCard()).getByRole("button", { name: "Remove key" }));
    await user.click(within(sttCard()).getByRole("button", { name: "Remove key" }));
    await user.click(within(sttCard()).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const last = api.log.filter((r) => r.method === "PUT").at(-1)!.body as Record<
        string,
        unknown
      >;
      expect(last.apiKey).toBeNull();
    });
  });

  it("marks third-party kinds and explains the CLI subscription kinds", async () => {
    installMock({ signedIn: true });
    const user = userEvent.setup();
    renderWithProviders(
      <MeGate>
        <ProvidersSettings />
      </MeGate>,
      "/settings/providers",
    );
    const llm = (await screen.findByRole("heading", { name: "Language model" })).closest(
      "section",
    ) as HTMLElement;
    expect(within(llm).getAllByText("Runs on your infrastructure").length).toBeGreaterThan(0);
    // Unavailable kinds are disabled and show the server's reason.
    expect(within(llm).getByText("The codex command was not found on the server.")).toBeTruthy();
    expect(
      (within(llm).getByRole("radio", { name: /Codex CLI/ }) as HTMLInputElement).disabled,
    ).toBe(true);
    await user.click(within(llm).getByRole("radio", { name: /Claude Code CLI/ }));
    expect(within(llm).getByText(/official Claude Code command-line tool/)).toBeTruthy();
    expect(within(llm).getByText(/Content leaves your server/)).toBeTruthy();
  });
});
