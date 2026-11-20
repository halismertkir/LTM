import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { agentCommand, defaultAccess, needsCode, PAIR_TARGETS } from "../src/lib/pairing";
import { installMock, renderApp } from "./helpers";

describe("pairing defaults", () => {
  it("pre-selects memory access only for the iPhone app", () => {
    expect(Object.fromEntries(PAIR_TARGETS.map((t) => [t, defaultAccess(t)]))).toEqual({
      extension: "capture",
      iphone: "memory",
      watch: "capture",
      agent: "capture",
      browser: "capture",
    });
  });
  it("shows a code except for the watch and this browser", () => {
    expect(PAIR_TARGETS.filter(needsCode)).toEqual(["extension", "iphone", "agent"]);
    expect(agentCommand("https://ltm.example.test", "K7QF-2MXD")).toBe(
      "ltm-agent pair --server https://ltm.example.test --code K7QF-2MXD",
    );
  });
});

describe("pairing dialog", () => {
  it("requests a code with the chosen access and tailors the instructions", async () => {
    const api = installMock({ signedIn: true });
    const user = userEvent.setup();
    renderApp("/devices?pair=1");
    const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
    await within(dialog).findByText("K7QF-2MXD");
    const memory = within(dialog).getByRole("checkbox", {
      name: /may also read, search and ask/,
    }) as HTMLInputElement;
    expect(memory.checked).toBe(false);
    expect(api.log.filter((r) => r.path === "/devices/pairing-codes").at(-1)?.body).toEqual({
      access: "capture",
    });

    await user.click(within(dialog).getByRole("radio", { name: "iPhone app" }));
    await within(dialog).findByText("M3RV-8QPA");
    expect(
      (within(dialog).getByRole("checkbox", { name: /may also read/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(api.log.filter((r) => r.path === "/devices/pairing-codes").at(-1)?.body).toEqual({
      access: "memory",
    });
    expect(within(dialog).getByText(/Scan the QR code/)).toBeTruthy();

    await user.click(within(dialog).getByRole("radio", { name: "Capture agent on a computer" }));
    await within(dialog).findByText("K7QF-2MXD");
    expect(within(dialog).getByText(/ltm-agent pair --server .* --code K7QF-2MXD/)).toBeTruthy();

    await user.click(within(dialog).getByRole("radio", { name: "Apple Watch" }));
    expect(within(dialog).queryByText("K7QF-2MXD")).toBeNull();
    expect(within(dialog).queryByRole("checkbox", { name: /may also read/ })).toBeNull();
    expect(within(dialog).getByText(/Pair your iPhone first/)).toBeTruthy();
  });

  it("shows each device's access and lets the user change it", async () => {
    const api = installMock({ signedIn: true });
    const user = userEvent.setup();
    renderApp("/devices");
    const card = (await screen.findByRole("heading", { name: "Work laptop · Chrome" })).closest(
      "li",
    )!;
    expect(within(card).getByText("Capture only")).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: /Edit/ }));
    const dialog = await screen.findByRole("dialog", { name: "Edit device" });
    await user.click(within(dialog).getByRole("radio", { name: /Capture and read my memory/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        api.log.find((r) => r.method === "PATCH" && r.path === "/devices/dev-laptop")?.body,
      ).toMatchObject({
        access: "memory",
      }),
    );
    expect(await within(card).findByText("Capture + memory")).toBeTruthy();
  });
});
