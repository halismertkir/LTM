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

> **Status: written without a Mac.** None of this code has been compiled or run yet. It
> was checked statically only (see "What is untested" below). Expect a first round of
> compile fixes on Xcode.

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
4. **Unit tests** (pure logic, run on the Mac without a simulator):

   ```sh
   cd apps/apple/LTMKit && swift test
   ```

   or open `LTMKit/Package.swift` in Xcode and press ⌘U. The consent test reads
   `packages/protocol/consent/consent.v1.json` from the repository, so run it from a
   checkout.

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

## What is untested

Everything. Nothing here has been compiled, run in a simulator, or run on a device.
Verified statically on Linux: JSON / plist / YAML files parse, every path in `project.yml`
exists, Swift delimiters balance, every localisation key used in code exists in both
languages with matching format specifiers, Codable field names were cross-checked against
the zod schemas, and the energy-gate expectations in the tests were reproduced with a
small Python model. Areas that most need a first run on a Mac:

1. Compile errors in general (actor isolation, `Sendable`, SDK signature details).
2. XcodeGen embedding of the single-target watch app and its signing.
3. `AudioCapture` on a device: session options, background recording, interruptions,
   route changes, the converter's output and the host-time mapping.
4. Background `URLSession` uploads and relaunch handling.
5. `AVAudioFile` AAC writing at 16 kHz and the watch's `AVAudioRecorder` rotation.
6. WatchConnectivity flows (pairing via the phone, file hand-off, context sync).
7. `SFSpeechRecognizer` on-device results and their timestamps.
8. The `LTMKit` unit tests themselves (`swift test`).

## Deliberately not included (yet)

- **Live Activity / Dynamic Island** and a **watch complication / Smart Stack widget**:
  both need extension targets and APIs that should be verified on a Mac first. The system
  recording indicator plus the in-app state are the capture indicators for now.
- Strict-concurrency build setting: the code is written with `Sendable`/actor isolation in
  mind, but `SWIFT_STRICT_CONCURRENCY` is left at the default. Turn it to `complete` once
  the first build is green.
