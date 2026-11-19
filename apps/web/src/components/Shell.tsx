import { useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useMeData } from "../api/queries";
import { useSession } from "../api/session";
import { type MessageKey, useI18n } from "../i18n";
import { type ThemeMode, useTheme } from "../lib/theme";
import { CaptureStatus } from "./CaptureStatus";
import {
  IconAuto,
  IconDevices,
  IconLogout,
  IconMemory,
  IconMoon,
  IconSearch,
  IconSettings,
  IconSun,
  IconTimeline,
} from "./Icons";

const NAV: { to: string; key: MessageKey; icon: typeof IconTimeline; end?: boolean }[] = [
  { to: "/", key: "nav.timeline", icon: IconTimeline, end: true },
  { to: "/memories", key: "nav.memories", icon: IconMemory },
  { to: "/search", key: "nav.search", icon: IconSearch },
  { to: "/devices", key: "nav.devices", icon: IconDevices },
  { to: "/settings", key: "nav.settings", icon: IconSettings },
];

const NEXT_THEME: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" };
const THEME_KEY: Record<ThemeMode, MessageKey> = {
  system: "prefs.themeSystem",
  light: "prefs.themeLight",
  dark: "prefs.themeDark",
};

export function Wordmark() {
  return (
    <span className="wordmark">
      <span className="wordmark-mark" aria-hidden="true">
        L
      </span>
      <span className="wordmark-text">LTM</span>
    </span>
  );
}

function Prefs({ showLogout }: { showLogout: boolean }) {
  const { t, locale, setLocale } = useI18n();
  const [theme, setTheme] = useTheme();
  const session = useSession();
  const ThemeIcon = theme === "light" ? IconSun : theme === "dark" ? IconMoon : IconAuto;
  const themeLabel = t("prefs.theme", { mode: t(THEME_KEY[theme]) });
  return (
    <div className="prefs">
      <button
        type="button"
        className="icon-btn"
        onClick={() => setTheme(NEXT_THEME[theme])}
        aria-label={themeLabel}
        title={themeLabel}
      >
        <ThemeIcon />
      </button>
      <button
        type="button"
        className="icon-btn lang-btn"
        onClick={() => setLocale(locale === "en" ? "tr" : "en")}
        aria-label={t("prefs.language")}
        title={t("prefs.language")}
      >
        <span aria-hidden="true">{locale === "en" ? "TR" : "EN"}</span>
      </button>
      {showLogout && (
        <button
          type="button"
          className="icon-btn"
          onClick={() => void session.logout().catch(() => {})}
          aria-label={t("auth.logout")}
          title={t("auth.logout")}
        >
          <IconLogout />
        </button>
      )}
    </div>
  );
}

export function Shell() {
  const { t } = useI18n();
  const me = useMeData();
  const location = useLocation();

  // Move focus to the new page's heading on navigation so screen-reader users hear it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per route change on purpose
  useEffect(() => {
    const h = document.querySelector<HTMLElement>("main h1");
    if (h && location.hash === "") {
      h.tabIndex = -1;
      h.focus({ preventScroll: true });
    }
  }, [location.pathname, location.hash]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t("nav.skip")}
      </a>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Wordmark />
          <span className="sidebar-tag">{t("brand.tagline")}</span>
        </div>
        <CaptureStatus />
        <nav aria-label={t("nav.main")} className="side-nav">
          {NAV.map(({ to, key, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className="side-link">
              <Icon />
              <span>{t(key)}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="whoami">
            <span className="avatar" aria-hidden="true">
              {me.user.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="whoami-text">
              <strong>{me.user.displayName}</strong>
              <span>{me.user.email}</span>
            </span>
          </div>
          <Prefs showLogout />
        </div>
      </aside>

      <header className="topbar">
        <Wordmark />
        <CaptureStatus compact />
        <Prefs showLogout />
      </header>

      <main id="main" className="main">
        <Outlet />
      </main>

      <nav aria-label={t("nav.main")} className="bottom-nav">
        {NAV.map(({ to, key, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className="bottom-link">
            <Icon size={20} />
            <span>{t(key)}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
