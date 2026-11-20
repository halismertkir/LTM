# LTM for iPhone and Apple Watch

The phone and the watch are LTM's ears for face-to-face conversations away from the desk.
Both are thin capture clients of the protocol in [`packages/protocol`](../../packages/protocol):
they pair as devices, honour the consent gate, and send audio (or on-device transcripts) to
your own LTM server.

```
apps/apple/
  project.yml        XcodeGen spec → LTM.xcodeproj (generated, git-ignored)
  LTMKit/            Swift package shared by both apps (+ unit tests)
  LTMiOS/            SwiftUI iPhone app (Sources, Resources, Info.plist, entitlements)
  LTMWatch/          SwiftUI watchOS app (single-target watch app, companion of LTMiOS)
```

> **Verification status**
> - **Compiler-verified on Linux** (Swift 6.4 toolchain, Swift 5 language mode): the
>   platform-neutral part of `LTMKit` — protocol models, frame encoder, API client and
>   reader API, multipart builder, pairing URI, stream client, SSE parser and live-event
>   client, energy gate / block assembler / chunk cutter, upload store, decisions and queue,
>   capture policy/state/coordinator, consent catalog, reader view models. `swift build`
>   is warning-free (also with `-strict-concurrency=complete`) and `swift test` runs
>   102 tests green.
> - **Verified by CI once the workflow is green** (`.github/workflows/apple.yml`, macOS):
>   `swift test` on macOS and unsigned simulator builds of the `LTMiOS` and `LTMWatch`
>   schemes — which is the only compiler that sees the SwiftUI screens and the
>   Apple-only layers (AVFoundation capture, Speech, WatchConnectivity, Keychain,
>   background `URLSession`, App Intents).
> - **Needs a physical device**: audio-session behaviour with the screen locked and
>   after interruptions, the watch's background recording and battery cost,
>   WatchConnectivity transfers between real devices, on-device speech recognition, and
>   background upload relaunches.

## Prerequisites

- macOS with **Xcode 15.3 or newer** (Swift 5.10 compiler; the code uses the Swift 5
  language mode, `SWIFT_VERSION = 5.0`).
- **XcodeGen 2.38+**: `brew install xcodegen`. Older versions may not embed a
  single-target watch app correctly.
- An iPhone with **iOS 17+**; optionally a paired Apple Watch with **watchOS 10+**.
- A running LTM server (see `docs/`), reachable from the phone.

No third-party Swift dependencies.

## Build and run

```sh
cd apps/apple
xcodegen generate          # creates LTM.xcodeproj from project.yml
open LTM.xcodeproj
```

1. **Signing**: `DEVELOPMENT_TEAM` is empty on purpose. In Xcode select the `LTMiOS` and
   `LTMWatch` targets → *Signing & Capabilities* → choose your team (or set
   `DEVELOPMENT_TEAM` in `project.yml` locally and do not commit it).
2. **Bundle identifiers** are placeholders: `app.ltm.ios` and `app.ltm.ios.watchkitapp`.
   Change `LTM_IOS_BUNDLE_ID` in `project.yml` if they are taken for your team; the watch
   id and `WKCompanionAppBundleIdentifier` follow automatically.
3. Run the **`LTMiOS`** scheme on the iPhone. The watch app is embedded in the iPhone app
   and installed with it; to debug it, run the **`LTMWatch`** scheme on the watch.
4. **Unit tests** (pure logic; macOS or Linux, no simulator):

   ```sh
   cd apps/apple/LTMKit && swift test
   ```

   or open `LTMKit/Package.swift` in Xcode and press ⌘U. On Linux, Apple-only frameworks
   are compiled out (`canImport` guards; `os.Logger` falls back to stderr, `Combine` to an
   inert `ObservableObject`/`@Published` stand-in used only by the tests). The consent test
   reads `packages/protocol/consent/consent.v1.json` from the repository, so run it from
   a checkout.

### Capabilities

Nothing needs to be enabled in the developer portal: background modes are Info.plist
keys, not entitlements, and the Keychain is used without sharing groups.

| Where | Key | Why |
| --- | --- | --- |
| iPhone | `UIBackgroundModes: audio` | Keeps a running recording alive with the screen locked. |
| Watch | `WKBackgroundModes: audio` | Lets a recording continue after the wrist is lowered. |
| Both | `NSAppTransportSecurity / NSAllowsLocalNetworking` | Plain HTTP only for local-network hosts. |
| iPhone | `NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`, `NSCameraUsageDescription`, `NSLocalNetworkUsageDescription` | Purpose strings (EN + TR via `InfoPlist.strings`). |
| iPhone | `CFBundleURLTypes: ltm` | Opening an `ltm://pair?...` link (e.g. from the Camera app) prefills pairing. |

Entitlement files exist but are empty. If you later add a widget, Live Activity or an
App Group, add it there.

## The phone as a reader

Once paired and consented, the iPhone app is a full reader of your memory:

- **Today** — the day's digest (headline, summary, highlights, decisions, people, open
  action items you can tick in place), the day's conversations, and a compact capture
  control with the live caption, so capture stays one tap away.
- **Timeline** — days (newest first) → a day's digest; or all conversations with search
  and infinite paging. Conversations still in progress are shown as *Live · notes so
  far* (`interim`).
- **Conversation** — title, status, summary, notes (Markdown rendered block by block:
  headings, lists, quotes, code; inline styles via `AttributedString(markdown:)`, plain
  text if that fails), decisions, action items, the merged transcript with time,
  speaker, source and "heard by N devices" badges, and the memories extracted from it.
- **Ask** — a thread of questions; each is one `/ask` call scoped to today, 7 days or
  everything. Answers cite [1], [2], … and each citation opens its conversation or memory.
- **Memories** — list, kind filter, search, add.
- **Capture** — the capture screen and settings from before. With memory access the
  account-wide pause is a switch (`POST /capture/pause`) and reacts to `capture_paused`
  live events; the watch follows through the phone.

Live updates come from `GET /events` (server-sent events, parsed by a small pure parser;
unknown event types are ignored so a newer server never breaks an older app), followed
while the app is in the foreground and reconnected with back-off.

**Device access.** Reading needs the phone to be paired with `access: "memory"` (the web
app's pairing dialog pre-selects it for an iPhone). The phone then calls exactly the
memory routes the server allows for device tokens — no account password is ever stored
on the phone. A phone paired with `access: "capture"` keeps capturing; the reader tabs
explain how to allow reading (web app → Devices) and offer a retry. A `403 forbidden`
anywhere switches the reader to that explanation instead of showing errors.

## Pairing

### iPhone

1. In the LTM web app open **Devices → Add device**. It shows a QR code
   (`ltm://pair?server=<origin>&code=<code>`) and the code.
2. In the iPhone app: **Scan QR code**, or type the server address and the code.
3. The app checks `/version` (a protocol mismatch is reported as such), pairs with
   `POST /devices/pair` (`kind: "iphone"`), stores the token in the Keychain, then shows
   the consent documents. Nothing is captured before they are accepted.

### Apple Watch (the watch is its own device)

`POST /devices/pairing-codes` needs a *user session*; the phone only holds a device token
and cannot mint codes. So the watch is paired with a **second code**:

1. In the web app, **Devices → Add device** again, creating a new code.
2. Open LTM on the watch, then on the iPhone **Settings → Apple Watch**, scan or type the
   code.
3. The phone sends the code to the watch (`WCSession.sendMessage`); the watch calls
   `/devices/pair` itself with `kind: "apple_watch"` and reports the token back (reply +
   `transferUserInfo`).
4. If the watch app is not reachable or cannot reach the server, the phone pairs **on
   the watch's behalf** with the same code (still `kind: "apple_watch"`) and delivers the
   token to the watch in the application context.

Either way the phone keeps the watch's token, because when the watch has no route to
the server it hands its chunks to the phone (`WCSession.transferFile`, job JSON in the
file metadata) and the phone uploads them **with the watch's token and stream id**, so
they are attributed to the watch. Consent and pause state are synced phone → watch via
`updateApplicationContext`; the watch also asks `/me` itself when it can reach the server.
The watch never captures without a watch token and a satisfied consent state.

Un-pairing deletes tokens locally. A device token cannot revoke itself, so the app tells
you to remove the device in the web app as well.

## HTTP, HTTPS and App Transport Security

The apps ship `NSAllowsLocalNetworking` only. iOS then allows plain HTTP to local-network
hosts (`.local` names, unqualified host names, IP addresses) and requires HTTPS for
everything else. The pairing screen warns when you enter `http://` for a non-local host.

For a self-hosted server reachable from outside your home, put it behind HTTPS, e.g.:

- a reverse proxy such as **Caddy** (automatic Let's Encrypt certificates) in front of
  the LTM server, or
- a private network such as **Tailscale** with its HTTPS certificates enabled.

Self-signed certificates only work if the certificate is installed and trusted on the
device (Settings → General → About → Certificate Trust Settings).

## How capture works

- **`CaptureCoordinator`** (`@MainActor ObservableObject`) is the single state machine the
  UIs render: `notPaired / consentRequired / idle / listening(mode) / paused / error`. It
  enforces the client-side gate (paired + consent satisfied + not paused) and stops or
  pauses capture when any gate closes.
- **Transport policy** (`CapturePolicy`, one small pure function): by default live
  WebSocket when the app is in the foreground on Wi-Fi (live captions), compressed chunks
  in the background or on cellular. Settings → Capture mode can force either.
- **iPhone audio**: `AVAudioSession` `.playAndRecord` / `.default` with `.mixWithOthers`,
  `.defaultToSpeaker`, `.allowBluetoothA2DP` (other apps keep playing; the built-in mic
  keeps capturing the room; see `AudioCapture.swift` for the reasoning), `AVAudioEngine`
  input tap → `AVAudioConverter` → 16 kHz mono Int16 → 200 ms blocks stamped from the
  buffer's host time. Interruptions, route changes, engine configuration changes and
  media-services resets restart the engine and flag a discontinuity.
- **`EnergyGate`** drops silence (adaptive noise floor, hangover, pre-roll) and delimits
  speech windows for chunk cuts and on-device recognition.
- **Live**: `StreamClient` (actor) — hello → ready → frames, ping every 15 s, end → closed,
  reconnect with back-off + jitter on the same `streamId`, ~65 s bounded offline buffer.
- **Store-and-forward**: `ChunkRecorder` writes AAC `.m4a` chunks (cut at a pause after
  ~25 s, hard cut at 40 s), `UploadQueue` persists jobs on disk and uploads through a
  background `URLSession` (multipart body written to a file, delegate-based completion,
  2xx deletes the audio, `unauthorized` stops, `consent_required`/`ingest_paused` pause).
- **On-device transcription**: `SFSpeechRecognizer` with
  `requiresOnDeviceRecognition = true`, only when `supportsOnDeviceRecognition` is true for
  the language; otherwise the app refuses and offers server mode — it never silently uses
  Apple's server recognition. One request per speech window (≤ 28 s). Results go out as a
  `transcript` stream or `POST /ingest/transcripts`. Newer speech APIs in recent OS
  releases could replace `SFSpeechRecognizer` later; this build deliberately uses the
  long-established API.
- **Relaunch**: the upload queue resumes by itself (also when iOS relaunches the app in
  the background for upload events). Capture is **not** resumed after a cold relaunch
  unless the user enabled *Resume capture after a restart*.
- **Shortcuts**: App Intents for start / pause / stop (start opens the app, because iOS
  only lets recording begin in the foreground).

### Apple Watch

`AVAudioRecorder` writes rotating ~30 s AAC chunks (16 kHz mono); its meter drives the
same `EnergyGate` to cut at pauses and to delete silent chunks. Each recording starts with
`record(atTime:)` at a known device time, which gives the chunk an exact wall-clock start.
Uploads go directly to the server with a short timeout; on a transport failure the chunk is
handed to the phone. Haptics on start/stop.

**watchOS background limits, honestly:** background recording relies on the `audio`
background mode, and watchOS is stricter than iOS. Expect the system to end long sessions,
especially on battery-constrained watches, and verify on hardware how long a session
survives with the wrist down. Recording continuously costs significant battery (microphone,
AAC encoder, radio). Uploads only run while the app is running; leftovers continue at the
next launch or go through the phone.

## Localisation, privacy, store hygiene

- EN + TR for every user-facing string: `Resources/{en,tr}.lproj/Localizable.strings`,
  `InfoPlist.strings` (purpose strings) and `AppShortcuts.strings` (Siri phrases). Keys are
  semantic; a missing translation shows the key.
- Consent texts and notice templates are **not** in these files: the canonical
  `packages/protocol/consent/consent.v1.json` is bundled by `project.yml` (relative path)
  and decoded at runtime.
- `PrivacyInfo.xcprivacy` in both apps: no tracking, no tracking domains; collected data
  types *audio* and *other user content* (sent only to the user's own server, for app
  functionality); required-reason APIs: UserDefaults (`CA92.1`) and, on the iPhone, system
  boot time (`35F9.1`, `mach_absolute_time` to timestamp audio buffers). Revisit the
  collected-data declaration for your own distribution.
- No analytics, no third-party SDKs, no logging of transcript text or tokens.
- **App icon**: the asset catalogs contain an empty single-size `AppIcon` slot (1024×1024)
  and an accent colour. Add your own artwork; Xcode warns until you do, and App Store
  submission requires it.

## What is verified where

- **Linux compiler + tests**: everything listed under "Verification status" above;
  the wire formats are pinned by literal-JSON and byte-level tests, and every Swift DTO
  was cross-checked field by field against the zod schemas by script.
- **macOS CI** (once green): the same tests on macOS, plus the first compile of the
  SwiftUI screens and Apple-only layers for iOS and watchOS simulators.
- **Static checks** (scripts, any OS): plists/JSON/YAML parse, every `project.yml` path
  exists, every localisation key exists in EN and TR with matching format specifiers.
- **Only on devices**: background recording and interruptions, watch recording and
  battery, WatchConnectivity, on-device Speech, background upload relaunch, the camera
  QR scanner.

## Deliberately not included (yet)

- **Live Activity / Dynamic Island** and a **watch complication / Smart Stack widget**:
  both need extension targets and APIs that should be verified on a Mac first. The system
  recording indicator plus the in-app state are the capture indicators for now.
- Strict-concurrency build setting: the code is written with `Sendable`/actor isolation in
  mind, but `SWIFT_STRICT_CONCURRENCY` is left at the default. Turn it to `complete` once
  the first build is green.
