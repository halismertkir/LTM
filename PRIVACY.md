# Privacy

This document describes what the LTM **software** does with data. It is not the privacy
policy of any particular deployment: whoever operates an LTM server (you, if you
self-host) is responsible for that deployment and, under laws such as the GDPR and
Turkey's KVKK, is typically the *data controller* for what it stores.

## The short version

- A self-hosted LTM server sends nothing to the authors of LTM. There is no telemetry,
  no analytics, no update ping, no remote fonts or scripts.
- Data leaves your server only towards the AI providers **you** configure, and never
  towards one you did not.
- Raw audio is deleted as soon as it has been transcribed unless you turn retention on.
- Capture is impossible until the account has accepted the consent documents, and can be
  paused account-wide with one switch.

## What is processed

| Data | Where it comes from | Where it is stored | Kept until |
| --- | --- | --- | --- |
| Audio | Paired devices: browser tab audio, microphones, watch | Server disk (`LTM_DATA_DIR/audio`) | Transcribed (default), or the audio retention period you set |
| Transcript segments | Speech-to-text on the server, or on the device in on-device mode | Database | You delete them, or the data retention period expires |
| Merged transcript, summaries, notes, action items, memories | Derived by the pipeline and the configured language model | Database | Same |
| Embeddings | Derived from the above by the embedding provider | Database | Same |
| Account | E-mail address, display name, password hash (scrypt), locale | Database | Account deletion |
| Devices | Name, kind, platform, app version, last-seen time, hashed token | Database | Device removal |
| Consent records | Which document version was accepted, when, from which client | Database | Account deletion |
| Provider settings | Kind, model, base URL, API key (encrypted with AES-256-GCM) | Database | You change or remove them |

Conversations usually contain other people's words and may include special categories of
personal data (health, beliefs, and so on). LTM does not build voiceprints and does not
identify speakers biometrically.

## Where data goes

```
device ──► your LTM server ──► the speech-to-text provider you configured   (audio)
                           ──► the language model you configured            (transcript text)
                           ──► the embedding provider you configured        (text)
```

- With **local models** (an OpenAI-compatible endpoint on your own machine) nothing
  leaves your infrastructure.
- With **on-device transcription** audio does not leave the capturing device; only text
  is uploaded to your server.
- With a **third-party provider** (Anthropic, OpenAI, or a Claude / ChatGPT subscription
  through the vendor's CLI) the corresponding content is transmitted to that provider and
  handled under its terms. LTM requires an additional explicit consent before it does
  this and labels such providers in the settings.

Capture clients talk only to the server address you paired them with. The Chrome
extension sends the hostname and title of the captured tab as context, never full URLs.

## Your controls

- **Pause** capture account-wide, or per device.
- **Export** everything the server holds about you as JSON.
- **Delete** single conversations and memories, all captured data (optionally before a
  date), or the whole account. Deletions are hard deletes; backups you made yourself are
  your responsibility.
- **Retention** periods for audio and for derived data.
- **Withdraw consent** at any time; capture stops immediately.

## Other people's rights

People you record have rights too — to know, to object, and in many jurisdictions to
access or erase data about them. LTM gives you the tools (search, per-conversation
deletion, export), but honouring such requests is the responsibility of whoever runs the
server. See [`docs/legal/CONSENT.md`](docs/legal/CONSENT.md).

## Security measures in the software

Passwords are hashed with scrypt; session and device tokens are stored only as hashes;
API keys are encrypted at rest; transcript content is not written to logs; every query is
scoped to the authenticated account. Transport encryption is the operator's job: put the
server behind HTTPS (see [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md)). Data at rest
is not encrypted by LTM itself — use disk encryption on the host.

## Children

LTM is not intended for use by children, and must not be used to record them without the
consent the law requires from their guardians.
