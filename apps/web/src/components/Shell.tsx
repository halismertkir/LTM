import { type FormEvent, useEffect, useId, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useMeData } from "../api/queries";
import { useSession } from "../api/session";
import { type MessageKey, useI18n } from "../i18n";
import { useSwitchLocale } from "../lib/locale";
import { type ThemeMode, useTheme } from "../lib/theme";
import { CaptureStatus } from "./CaptureStatus";
import {
  IconAuto,
  IconCalendar,
  IconDevices,
  IconLogout,
  IconMemory,
  IconMoon,
  IconMore,
  IconSettings,
  IconSparkle,
  IconSun,
  IconTimeline,
} from "./Icons";

type NavItem = { to: string; key: MessageKey; icon: typeof IconTimeline; end?: boolean };
const NAV: NavItem[] = [
  { to: "/", key: "nav.days", icon: IconCalendar, end: true },
  { to: "/timeline", key: "nav.timeline", icon: IconTimeline },
  { to: "/ask", key: "nav.ask", icon: IconSparkle },
  { to: "/memories", key: "nav.memories", icon: IconMemory },
  { to: "/devices", key: "nav.devices", icon: IconDevices },
  { to: "/settings", key: "nav.settings", icon: IconSettings },
];
// The phone bar keeps five thumb-sized targets; Devices and Settings live under "More".
const PHONE_NAV: NavItem[] = [
  { to: "/", key: "nav.days", icon: IconCalendar, end: true },
  { to: "/timeline", key: "nav.timeline", icon: IconTimeline },
  { to: "/ask", key: "nav.ask", icon: IconSparkle },
  { to: "/memories", key: "nav.memories", icon: IconMemory },
  { to: "/more", key: "nav.more", icon: IconMore },
];

/** The "ask your memory" field in the sidebar: routes to the Ask page with the question running. */
function AskBox() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const id = useId();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const question = q.trim();
    if (!question) return;
    setQ("");
    navigate(`/ask?q=${encodeURIComponent(question)}`);
  };
  return (
    <search className="askbox">
      <form onSubmit={onSubmit}>
        <label htmlFor={id} className="sr-only">
          {t("ask.boxLabel")}
        </label>
        <IconSparkle size={16} />
        <input
          id={id}
          type="search"
          enterKeyHint="send"
          placeholder={t("ask.boxPlaceholder")}
          value={q}
          maxLength={2000}
          onChange={(e) => setQ(e.target.value)}
        />
      </form>
    </search>
  );
}

const NEXT_THEME: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" };
const THEME_KEY: Record<ThemeMode, MessageKey> = {
  system: "prefs.themeSystem",
  light: "prefs.themeLight",
  dark: "prefs.themeDark",
};

export { NEXT_THEME, THEME_KEY };

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
  const { t, locale } = useI18n();
  const switchLocale = useSwitchLocale();
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
        onClick={() => switchLocale(locale === "en" ? "tr" : "en")}
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
        <AskBox />
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
        <Prefs showLogout={false} />
      </header>

      <main id="main" className="main">
        <Outlet />
      </main>

      <nav aria-label={t("nav.main")} className="bottom-nav">
        {PHONE_NAV.map(({ to, key, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className="bottom-link">
            <Icon size={20} />
            <span>{t(key)}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
