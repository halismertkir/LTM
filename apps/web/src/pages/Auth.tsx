import type { Locale } from "@ltm/protocol";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { api } from "../api/client";
import { useSession } from "../api/session";
import { IconShield } from "../components/Icons";
import { Wordmark } from "../components/Shell";
import { ErrorNote } from "../components/ui";
import { useI18n } from "../i18n";

type Mode = "setup" | "login" | "register";

export function AuthScreen({
  mode: initialMode,
  registrationOpen,
}: {
  mode: Mode;
  registrationOpen: boolean;
}) {
  const { t, locale, setLocale } = useI18n();
  const session = useSession();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [accountLocale, setAccountLocale] = useState<Locale>(locale);
  const ids = {
    email: useId(),
    password: useId(),
    name: useId(),
    locale: useId(),
    pwHint: useId(),
  };

  useEffect(() => setMode(initialMode), [initialMode]);
  useEffect(() => setAccountLocale(locale), [locale]);

  const submit = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      if (mode === "login") return api.login({ email, password });
      const body = { email, password, displayName: displayName.trim(), locale: accountLocale };
      return mode === "setup" ? api.setup(body) : api.register(body);
    },
    onSuccess: async () => {
      await session.signedIn();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };

  const creating = mode !== "login";
  const tooShort = creating && password.length > 0 && password.length < 10;
  const title =
    mode === "setup"
      ? t("auth.setupTitle")
      : mode === "register"
        ? t("auth.registerTitle")
        : t("auth.loginTitle");

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-top">
          <Wordmark />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setLocale(locale === "en" ? "tr" : "en")}
            aria-label={t("prefs.language")}
          >
            {locale === "en" ? "Türkçe" : "English"}
          </button>
        </div>
        <main>
          <h1>{title}</h1>
          <p className="lead">
            {mode === "setup"
              ? t("auth.setupLead")
              : mode === "register"
                ? t("auth.registerLead")
                : t("auth.loginLead")}
          </p>

          <form className="stack" onSubmit={onSubmit} noValidate={false}>
            {creating && (
              <div className="field">
                <label htmlFor={ids.name}>{t("auth.displayName")}</label>
                <input
                  id={ids.name}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  autoComplete="name"
                  required
                  maxLength={80}
                />
              </div>
            )}
            <div className="field">
              <label htmlFor={ids.email}>{t("auth.email")}</label>
              <input
                id={ids.email}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete={creating ? "email" : "username"}
                required
                maxLength={254}
              />
            </div>
            <div className="field">
              <label htmlFor={ids.password}>{t("auth.password")}</label>
              <input
                id={ids.password}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={creating ? "new-password" : "current-password"}
                required
                minLength={creating ? 10 : 1}
                maxLength={200}
                aria-describedby={creating ? ids.pwHint : undefined}
                aria-invalid={tooShort || undefined}
              />
              {creating && (
                <p id={ids.pwHint} className={tooShort ? "hint hint-warn" : "hint"}>
                  {t("auth.passwordHint")}
                </p>
              )}
            </div>
            {creating && (
              <div className="field">
                <label htmlFor={ids.locale}>{t("auth.language")}</label>
                <select
                  id={ids.locale}
                  value={accountLocale}
                  onChange={(e) => setAccountLocale(e.target.value as Locale)}
                >
                  <option value="en">English</option>
                  <option value="tr">Türkçe</option>
                </select>
              </div>
            )}
            {submit.error && <ErrorNote error={submit.error} />}
            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={submit.isPending || tooShort}
            >
              {submit.isPending
                ? t("common.working")
                : mode === "login"
                  ? t("auth.loginSubmit")
                  : t("auth.createSubmit")}
            </button>
          </form>

          {mode === "login" && registrationOpen && (
            <p className="auth-switch">
              {t("auth.noAccount")}{" "}
              <button type="button" className="link-btn" onClick={() => setMode("register")}>
                {t("auth.registerLink")}
              </button>
            </p>
          )}
          {mode === "register" && (
            <p className="auth-switch">
              {t("auth.haveAccount")}{" "}
              <button type="button" className="link-btn" onClick={() => setMode("login")}>
                {t("auth.loginLink")}
              </button>
            </p>
          )}
        </main>
        <footer className="auth-foot">
          <IconShield size={16} />
          <span>{mode === "setup" ? t("auth.setupFoot") : t("auth.privacyFoot")}</span>
        </footer>
      </div>
    </div>
  );
}
