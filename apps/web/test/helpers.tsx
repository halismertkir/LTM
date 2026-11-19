import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { MockApi, type MockOptions, mockFetch } from "../mock/api";
import { App, createQueryClient } from "../src/App";
import { SessionProvider } from "../src/api/session";
import { ToastProvider } from "../src/components/Toast";
import { I18nProvider } from "../src/i18n";

export function installMock(opts: MockOptions = {}): MockApi {
  const api = new MockApi(opts);
  vi.stubGlobal("fetch", vi.fn(mockFetch(api)));
  return api;
}

/** The whole app, as the browser would load it at `path`. */
export function renderApp(path = "/") {
  window.history.replaceState(null, "", path);
  return render(<App />);
}

/** A single screen inside the same providers the app uses. */
export function renderWithProviders(ui: ReactNode, path = "/") {
  const qc = createQueryClient();
  return {
    qc,
    ...render(
      <I18nProvider initial="en">
        <QueryClientProvider client={qc}>
          <ToastProvider>
            <SessionProvider>
              <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
            </SessionProvider>
          </ToastProvider>
        </QueryClientProvider>
      </I18nProvider>,
    ),
  };
}
