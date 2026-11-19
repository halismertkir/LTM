import { Link } from "react-router";
import { EmptyState } from "../components/ui";
import { useI18n } from "../i18n";

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <EmptyState title={t("notFound.title")}>
      <p>{t("notFound.lead")}</p>
      <Link to="/" className="btn">
        {t("nav.timeline")}
      </Link>
    </EmptyState>
  );
}
