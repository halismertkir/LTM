import { Link } from "react-router";
import { useMeData } from "../api/queries";
import { useSession } from "../api/session";
import {
  IconChevron,
  IconDevices,
  IconLogout,
  IconMic,
  IconSearch,
  IconSettings,
} from "../components/Icons";
import { NEXT_THEME, THEME_KEY } from "../components/Shell";
import { PageHeader } from "../components/ui";
import { useI18n } from "../i18n";
import { useSwitchLocale } from "../lib/locale";
import { useTheme } from "../lib/theme";

/** Phone-sized home for everything that does not fit the five-tab bottom bar. */
export function MorePage() {
  const { t, locale } = useI18n();
  const me = useMeData();
  const session = useSession();
  const switchLocale = useSwitchLocale();
  const [theme, setTheme] = useTheme();
  return (
    <div className="page narrow">
      <PageHeader title={t("nav.more")} lead={`${me.user.displayName} · ${me.user.email}`} />
      <ul className="menu-list">
        <li>
          <Link to="/devices?listen=1">
            <IconMic /> <span>{t("listen.action")}</span> <IconChevron />
          </Link>
        </li>
        <li>
          <Link to="/devices">
            <IconDevices /> <span>{t("nav.devices")}</span> <IconChevron />
          </Link>
        </li>
        <li>
          <Link to="/search">
            <IconSearch /> <span>{t("search.tabSearch")}</span> <IconChevron />
          </Link>
        </li>
        <li>
          <Link to="/settings">
            <IconSettings /> <span>{t("nav.settings")}</span> <IconChevron />
          </Link>
        </li>
      </ul>
      <ul className="menu-list">
        <li>
          <button type="button" onClick={() => setTheme(NEXT_THEME[theme])}>
            <span>{t("prefs.themeLabel")}</span>
            <span className="muted">{t(THEME_KEY[theme])}</span>
          </button>
        </li>
        <li>
          <button type="button" onClick={() => switchLocale(locale === "en" ? "tr" : "en")}>
            <span>{t("prefs.languageLabel")}</span>
            <span className="muted">{locale === "en" ? "English" : "Türkçe"}</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="danger-text"
            onClick={() => void session.logout().catch(() => {})}
          >
            <IconLogout /> <span>{t("auth.logout")}</span>
          </button>
        </li>
      </ul>
    </div>
  );
}
