import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// The first render of a test file imports the whole app; on a small CI runner that can
// take longer than the library's default one second for findBy*/waitFor.
configure({ asyncUtilTimeout: 8000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  localStorage.clear();
});
