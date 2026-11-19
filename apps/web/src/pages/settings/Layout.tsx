import { Link, NavLink, Outlet } from "react-router";
import { useMeData } from "../../api/queries";
import { IconLock } from "../../components/Icons";
import { PageHeader } from "../../components/ui";
import { type MessageKey, useI18n } from "../../i18n";

const SECTIONS: { to: string; key: MessageKey }[] = [
  { to: "providers", key: "settings.providers" },
  { to: "privacy", key: "settings.privacy" },
  { to: "pipeline", key: "settings.pipeline" },
  { to: "data", key: "settings.data" },
  { to: "notices", key: "settings.notices" },
];

export function SettingsLayout() {
  const { t } = useI18n();
  const me = useMeData();
  return (
    <div className="page">
      <PageHeader title={t("settings.title")} lead={t("settings.lead")} />
      {!me.consent.satisfied && (
        <div className="note note-warn banner" role="status">
          <IconLock size={16} />
          <p>{t("settings.consentBanner")}</p>
          <Link to="/consent" className="btn btn-sm btn-warn">
            {t("capture.review")}
          </Link>
        </div>
      )}
      <nav className="tabs" aria-label={t("settings.sections")}>
        {SECTIONS.map((s) => (
          <NavLink key={s.to} to={s.to} className="tab">
            {t(s.key)}
          </NavLink>
        ))}
      </nav>
      <div className="settings-body">
        <Outlet />
      </div>
    </div>
  );
}
