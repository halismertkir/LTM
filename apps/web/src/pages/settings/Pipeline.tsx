import { type PipelineSettings, type Settings, zLanguage } from "@ltm/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { api } from "../../api/client";
import { qk, useSettings } from "../../api/queries";
import { useToast } from "../../components/Toast";
import { ErrorNote, Loading, Switch } from "../../components/ui";
import { useI18n } from "../../i18n";
import { formatTime } from "../../lib/format";
import { browserTimeZone, isValidTimeZone } from "../../lib/zone";

const LIVE_NOTES_CHOICES = [0, 5, 10, 15, 30, 60] as const;

function allTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

// Common choices; any other BCP-47 tag can be typed via "Other".
const LANGUAGES = ["en", "tr", "de", "fr", "es", "it", "nl", "pt", "ar", "ru", "ja", "zh"] as const;

function languageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function initialChoice(p: PipelineSettings): string {
  if (p.language === null) return "auto";
  return (LANGUAGES as readonly string[]).includes(p.language) ? p.language : "other";
}

function PipelineForm({ pipeline }: { pipeline: PipelineSettings }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [choice, setChoice] = useState(initialChoice(pipeline));
  const [other, setOther] = useState(pipeline.language ?? "");
  const [gap, setGap] = useState(String(pipeline.conversationGapMinutes));
  const [extract, setExtract] = useState(pipeline.extractMemories);
  const [liveNotes, setLiveNotes] = useState(pipeline.liveNotesMinutes);
  const [digest, setDigest] = useState(pipeline.dailyDigest);
  const [tz, setTz] = useState(pipeline.timeZone);
  const ids = {
    lang: useId(),
    other: useId(),
    gap: useId(),
    tz: useId(),
    tzList: useId(),
    live: useId(),
  };
  const zones = useMemo(allTimeZones, []);
  const deviceTz = browserTimeZone();

  useEffect(() => {
    setChoice(initialChoice(pipeline));
    setOther(pipeline.language ?? "");
    setGap(String(pipeline.conversationGapMinutes));
    setExtract(pipeline.extractMemories);
    setLiveNotes(pipeline.liveNotesMinutes);
    setDigest(pipeline.dailyDigest);
    setTz(pipeline.timeZone);
  }, [pipeline]);
  const tzInvalid = !isValidTimeZone(tz.trim()) || tz.trim() === "";
  // Keep an unusual server value selectable instead of silently changing it.
  const liveChoices = (LIVE_NOTES_CHOICES as readonly number[]).includes(pipeline.liveNotesMinutes)
    ? LIVE_NOTES_CHOICES
    : [...LIVE_NOTES_CHOICES, pipeline.liveNotesMinutes].sort((a, b) => a - b);

  const language = choice === "auto" ? null : choice === "other" ? other.trim() : choice;
  const langInvalid = language !== null && !zLanguage.safeParse(language).success;
  const gapN = Number(gap);
  const gapInvalid = !Number.isInteger(gapN) || gapN < 1 || gapN > 240;

  const save = useMutation({
    mutationFn: () =>
      api.putPipeline({
        language,
        conversationGapMinutes: gapN,
        extractMemories: extract,
        liveNotesMinutes: liveNotes,
        dailyDigest: digest,
        timeZone: tz.trim(),
      }),
    onSuccess: (p) => {
      qc.setQueryData<Settings>(qk.settings, (s) => (s ? { ...s, pipeline: p } : s));
      // A new zone moves day boundaries.
      void qc.invalidateQueries({ queryKey: qk.daysAll });
      void qc.invalidateQueries({ queryKey: qk.dayAll });
      toast.show(t("common.saved"), "success");
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!langInvalid && !gapInvalid && !tzInvalid) save.mutate();
  };

  return (
    <form className="card stack" onSubmit={onSubmit}>
      <div className="grid-2">
        <div className="field">
          <label htmlFor={ids.lang}>{t("pipeline.language")}</label>
          <select id={ids.lang} value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="auto">{t("pipeline.auto")}</option>
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {languageName(l, locale)}
              </option>
            ))}
            <option value="other">{t("pipeline.other")}</option>
          </select>
          <p className="hint">{t("pipeline.languageHint")}</p>
        </div>
        {choice === "other" && (
          <div className="field">
            <label htmlFor={ids.other}>{t("pipeline.otherCode")}</label>
            <input
              id={ids.other}
              value={other}
              onChange={(e) => setOther(e.target.value)}
              placeholder="pt-BR"
              aria-invalid={langInvalid || undefined}
              spellCheck={false}
            />
            {langInvalid && <p className="hint hint-warn">{t("pipeline.otherInvalid")}</p>}
          </div>
        )}
      </div>
      <div className="field field-inline">
        <label htmlFor={ids.gap}>{t("pipeline.gap")}</label>
        <input
          id={ids.gap}
          type="number"
          inputMode="numeric"
          min={1}
          max={240}
          value={gap}
          onChange={(e) => setGap(e.target.value)}
          aria-invalid={gapInvalid || undefined}
        />
        <p className="hint">{t("pipeline.gapHint")}</p>
      </div>
      <fieldset className="field">
        <legend id={ids.live}>{t("pipeline.liveNotes")}</legend>
        <div className="chip-group">
          {liveChoices.map((m) => (
            <label key={m} className={liveNotes === m ? "chip-toggle on" : "chip-toggle"}>
              <input
                type="radio"
                name={ids.live}
                checked={liveNotes === m}
                onChange={() => setLiveNotes(m)}
              />
              {m === 0 ? t("pipeline.liveNotesOff") : t("pipeline.liveNotesEvery", { n: m })}
            </label>
          ))}
        </div>
        <p className="hint">{t("pipeline.liveNotesHint")}</p>
      </fieldset>
      <Switch
        checked={digest}
        onChange={setDigest}
        label={t("pipeline.digest")}
        description={t("pipeline.digestHint")}
      />
      <div className="field">
        <label htmlFor={ids.tz}>{t("pipeline.timeZone")}</label>
        <div className="row tz-row">
          <input
            id={ids.tz}
            className="tz-input"
            list={ids.tzList}
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={tzInvalid || undefined}
          />
          {tz !== deviceTz && (
            <button type="button" className="btn btn-sm" onClick={() => setTz(deviceTz)}>
              {t("pipeline.useDeviceZone", { zone: deviceTz })}
            </button>
          )}
        </div>
        <datalist id={ids.tzList}>
          {zones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <p className={tzInvalid ? "hint hint-warn" : "hint"}>
          {tzInvalid
            ? t("pipeline.timeZoneInvalid")
            : t("pipeline.timeZoneHint", {
                time: formatTime(Date.now(), locale, false, tz.trim()),
              })}
        </p>
      </div>
      <Switch
        checked={extract}
        onChange={setExtract}
        label={t("pipeline.extract")}
        description={t("pipeline.extractHint")}
      />
      <div className="row">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={save.isPending || langInvalid || gapInvalid || tzInvalid}
        >
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}

export function PipelineSettingsPage() {
  const settings = useSettings();
  const { t } = useI18n();
  if (settings.isPending) return <Loading />;
  if (settings.error)
    return <ErrorNote error={settings.error} onRetry={() => void settings.refetch()} />;
  return (
    <div className="stack-lg">
      <p className="lead">{t("pipeline.lead")}</p>
      <PipelineForm pipeline={settings.data.pipeline} />
    </div>
  );
}
