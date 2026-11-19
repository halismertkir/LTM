import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";
const KEY = "ltm.theme";

export function readThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** `data-theme` overrides the `prefers-color-scheme` default in CSS; absent = follow system. */
export function applyThemeMode(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "system") delete root.dataset.theme;
  else root.dataset.theme = mode;
}

export function useTheme(): [ThemeMode, (m: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(readThemeMode);
  useEffect(() => applyThemeMode(mode), [mode]);
  const set = useCallback((m: ThemeMode) => {
    try {
      if (m === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, m);
    } catch {
      // Storage unavailable: keep the choice for this tab only.
    }
    setMode(m);
  }, []);
  return [mode, set];
}
