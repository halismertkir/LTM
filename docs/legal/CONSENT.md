# Consent, notices and recording law

> **This is not legal advice.** Recording law is local, changes, and depends on details.
> The texts shipped with LTM are templates. If you use LTM anywhere it matters — at work,
> with clients, across borders — check the rules that apply to you.

LTM records people. This document explains how the software handles consent, what it
expects from the person using it, and what an operator should think about.

## Two different kinds of consent

1. **The user's own consent** to having their voice and conversations processed. LTM
   collects this itself, in every client, before anything is captured.
2. **The consent (or at least knowledge) of everyone else in the conversation.** Software
   cannot collect this for you. LTM makes the user explicitly accept responsibility for
   it, keeps a visible indicator on while capturing, and provides notice texts.

## What the software enforces

- The canonical documents live in
  [`packages/protocol/consent/consent.v1.json`](../../packages/protocol/consent/consent.v1.json),
  in English and Turkish, and are shown unchanged by the web app, the Chrome extension
  and the iOS/watchOS apps.

  | Document | Required | Says |
  | --- | --- | --- |
  | `recording_responsibility` | Always | You must inform others and obtain consent where the law requires it; you will not use LTM for covert monitoring. |
  | `data_processing` | Always | What is captured, where it is processed, retention, your controls. |
  | `third_party_ai` | Once a provider outside your infrastructure is configured | Audio/transcripts — including other people's words — are sent to that provider. |

- Acceptance is recorded per account with document **version**, time and client. When a
  document's version changes, it must be accepted again.
- **The server refuses every capture path** (`consent_required`) until all currently
  required documents are accepted. Clients cannot bypass this.
- Checkboxes are never pre-ticked. Withdrawing consent stops capture immediately.
- Every client shows an unmistakable "capturing" state and offers pause in one action.
  Clients never start recording a meeting without a user action.

## Notice templates

Ship with the apps (copy button / share sheet) and can be adapted:

| Situation | English | Türkçe |
| --- | --- | --- |
| Face to face | "Just so you know: I use a personal note-taking tool that records and transcribes my conversations. Are you okay with that? If not, I'll pause it now." | "Bilginize: Konuşmalarımı kaydeden ve yazıya döken kişisel bir not alma aracı kullanıyorum. Sizin için uygun mu? Değilse hemen duraklatıyorum." |
| Meeting chat | "Heads-up: I'm using LTM, a personal note-taking tool, to record and transcribe this meeting for my own notes. If anyone objects, tell me and I'll turn it off." | "Bilgilendirme: Bu toplantıyı kendi notlarım için LTM adlı kişisel not alma aracıyla kaydediyor ve yazıya döküyorum. İtirazı olan varsa lütfen söylesin, hemen kapatayım." |
| When an external AI is used | "The transcript is processed by an external AI service to produce notes." | "Döküm, not çıkarmak için harici bir yapay zekâ hizmeti tarafından işlenmektedir." |

Good practice regardless of jurisdiction: say it at the start, say it again when someone
joins, and stop when someone objects.

## A rough map of recording law

Indicative only, and deliberately incomplete.

| Where | Broadly |
| --- | --- |
| **Türkiye** | Recording non-public conversations without the consent of the parties can be a criminal offence under the Turkish Penal Code (arts. 132–136: confidentiality of communication, listening to and recording conversations between persons, violation of privacy, unlawful recording and disclosure of personal data). Processing voice and conversation content is processing personal data under KVKK (Law No. 6698): it needs a legal basis — in practice explicit consent after proper information (*aydınlatma*) — and sending it to providers abroad is a cross-border transfer with its own conditions. |
| **EU / EEA / UK** | The GDPR applies to recordings of identifiable people. The "purely personal or household activity" exemption is narrow and generally does not cover work contexts. National criminal law on recording conversations varies a lot: some countries prohibit recording without everyone's consent (e.g. Germany), others allow a participant to record for their own use. |
| **United States** | Federal law and most states allow recording when one party consents; a number of states (including California, Florida, Illinois, Washington, Pennsylvania and others) require the consent of all parties, and calls across state lines get the stricter rule in practice. |
| **Elsewhere** | Check. Many countries criminalise covert recording, and employment, professional-secrecy and consumer rules often add requirements. |

Contexts that deserve extra caution everywhere: workplaces (employment law,
confidentiality, works councils), professional secrecy (medical, legal, financial),
minors, and any setting where people reasonably expect not to be recorded.

## If you operate an LTM server for other people

Even noncommercially (for example for your family), you decide how their data is
processed, which usually makes you the controller under the GDPR/KVKK. At minimum:

- Tell your users who runs the server, what is stored, for how long and which providers
  receive data — a deployment-specific privacy notice (KVKK: *aydınlatma metni*).
- Serve the instance over HTTPS only, encrypt the disk, back up carefully, restrict
  shell access.
- Have a way to honour access and erasure requests, including from people who were
  recorded but have no account (search + per-conversation deletion + export).
- Prefer local models; if you configure third-party providers, check their data
  processing terms and transfer mechanisms.
- Offering LTM to an organisation's staff or as a service is commercial use and needs a
  commercial license — see [`LICENSING.md`](../../LICENSING.md).

## Changing the consent texts

Edit `consent.v1.json`, bump the `version` of every document whose meaning changed, keep
English and Turkish in sync, and have a maintainer review it. Bumping the version makes
every client ask again, which is the point.
