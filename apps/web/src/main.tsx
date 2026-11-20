import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyThemeMode, readThemeMode } from "./lib/theme";
import "./styles.css";

// Apply a manually chosen theme before the first render to avoid a light flash.
applyThemeMode(readThemeMode());

// Installable app shell (production only: in dev the worker would serve stale modules).
// The worker caches only static files and never touches /api — see src/sw/sw.js.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // No worker (private mode, unsupported): the app works the same, just not offline.
    });
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
