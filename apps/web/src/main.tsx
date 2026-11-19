import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyThemeMode, readThemeMode } from "./lib/theme";
import "./styles.css";

// Apply a manually chosen theme before the first render to avoid a light flash.
applyThemeMode(readThemeMode());

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
