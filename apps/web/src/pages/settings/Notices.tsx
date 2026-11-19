import { type Locale, NOTICE_TEMPLATES } from "@ltm/protocol";
import { useSettings } from "../../api/queries";
import { IconCopy } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { useI18n } from "../../i18n";
import { copyText } from "../../lib/hooks";

const LANG_NAME: Record<Locale, string> = { en: "English", tr: "Türkçe" };

export function NoticesSettings() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const settings = useSettings();
  const p = settings.data?.providers;
  const thirdParty = !!p && (p.llm.thirdParty || p.stt.thirdParty || p.embedding.thirdParty);
  // The user's own language first.
  const langs: Locale[] = locale === "tr" ? ["tr", "en"] : ["en", "tr"];

  const copy = async (text: string) => {
    const ok = await copyText(text);
    toast.show(ok ? t("common.copied") : t("common.copyFailed"), ok ? "success" : "error");
  };

  const blocks = [
    {
      key: "spoken",
      title: t("notices.spoken"),
      hint: t("notices.spokenHint"),
      texts: NOTICE_TEMPLATES.spoken,
    },
    {
      key: "chat",
      title: t("notices.chat"),
      hint: t("notices.chatHint"),
      texts: NOTICE_TEMPLATES.meetingChat,
    },
  ] as const;

  return (
    <div className="stack-lg">
      <p className="lead">{t("notices.why")}</p>
      {thirdParty && <div className="note note-plain">{t("notices.thirdPartyIncluded")}</div>}
      {blocks.map((b) => (
        <section key={b.key} className="card stack" aria-labelledby={`notice-${b.key}`}>
          <div>
            <h2 id={`notice-${b.key}`}>{b.title}</h2>
            <p className="muted">{b.hint}</p>
          </div>
          <div className="notice-grid">
            {langs.map((l) => {
              const text = thirdParty
                ? `${b.texts[l]} ${NOTICE_TEMPLATES.thirdPartyAi[l]}`
                : b.texts[l];
              return (
                <figure key={l} className="notice" lang={l}>
                  <figcaption>{LANG_NAME[l]}</figcaption>
                  <blockquote>{text}</blockquote>
                  <button type="button" className="btn btn-sm" onClick={() => void copy(text)}>
                    <IconCopy size={14} /> {t("notices.copy", { lang: LANG_NAME[l] })}
                  </button>
                </figure>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
