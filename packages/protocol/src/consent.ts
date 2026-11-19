import consentJson from "../consent/consent.v1.json" with { type: "json" };
import type { Locale } from "./common.js";
import type { ConsentType, ProviderKind } from "./rest.js";
import { THIRD_PARTY_PROVIDER_KINDS } from "./rest.js";

export interface ConsentText {
  title: string;
  /** Markdown. */
  body: string;
}

export interface ConsentDocument {
  type: ConsentType;
  /** Acceptance is recorded per (type, version). */
  version: string;
  /** `always`, or only once a provider outside the user's infrastructure is configured. */
  requiredWhen: "always" | "third_party_provider";
  en: ConsentText;
  tr: ConsentText;
}

export interface NoticeTemplates {
  /** To read aloud in a face-to-face conversation. */
  spoken: Record<Locale, string>;
  /** To paste into a meeting chat. */
  meetingChat: Record<Locale, string>;
  /** Extra sentence when a third-party AI provider is in use. */
  thirdPartyAi: Record<Locale, string>;
}

/** The canonical consent documents, identical in every client (see consent/consent.v1.json). */
export const CONSENT_DOCUMENTS = consentJson.documents as ConsentDocument[];
export const NOTICE_TEMPLATES: NoticeTemplates = {
  spoken: consentJson.notices.spoken,
  meetingChat: consentJson.notices.meetingChat,
  thirdPartyAi: consentJson.notices.thirdPartyAi,
};

export function consentDocument(type: ConsentType): ConsentDocument {
  const doc = CONSENT_DOCUMENTS.find((d) => d.type === type);
  if (!doc) throw new Error(`unknown consent type: ${type}`);
  return doc;
}

/**
 * Which documents an account must have accepted (at their current version) before any
 * ingest is allowed, given the provider kinds that are effectively configured for it.
 */
export function requiredConsentDocuments(
  effectiveProviderKinds: readonly ProviderKind[],
): ConsentDocument[] {
  const usesThirdParty = effectiveProviderKinds.some((k) => THIRD_PARTY_PROVIDER_KINDS.includes(k));
  return CONSENT_DOCUMENTS.filter(
    (d) =>
      d.requiredWhen === "always" || (d.requiredWhen === "third_party_provider" && usesThirdParty),
  );
}
