# LTM Chrome extension (`@ltm/extension`)

The desktop "ear" of LTM: a Manifest V3 extension that records the audio of browser
meetings (Google Meet, Zoom web, Teams web, anything playing in a tab) and, optionally,
your microphone, and streams it to **your own** LTM server over the ingest WebSocket
defined in `packages/protocol`.

Nothing is ever recorded without a visible indicator: while a stream is open the toolbar
icon turns red and shows a **REC** badge (orange REC while reconnecting).

## Build and load

```sh
pnpm install                              # from the repo root
pnpm --filter @ltm/extension build        # → apps/extension/dist (unpacked extension)
pnpm --filter @ltm/extension dev          # same, rebuilt on every change
pnpm --filter @ltm/extension zip          # → apps/extension/build/ltm-extension-<version>.zip
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick
   `apps/extension/dist`.
2. The settings page opens on first install. Requires Chrome 116 or newer.

## Pairing

1. In the LTM dashboard, open **Devices → Pair a device** and create a code.
2. In the extension settings, enter the server address and the code. Pasting the
   `ltm://pair?server=…&code=…` link fills in both fields.
3. Chrome asks for permission to reach that server. This is the only site access the extension
   requests for your server.
4. The extension checks `GET /api/v1/version`, shows a clear error on a protocol mismatch,
   then calls `POST /devices/pair` and stores the device token in `chrome.storage.local`.
   If the address is plain `http` on anything other than localhost, you see a warning.
5. If the server needs consent, the settings page shows the canonical consent documents from
   `@ltm/protocol`, each with an unchecked checkbox. Accepting them calls `POST /consents`.
6. Click **Allow microphone** to grant microphone access. The offscreen document cannot show
   the prompt itself, so this has to happen on the settings page.

**Un-pair** deletes the token from the browser and gives back the host permission. To revoke
the token on the server too, remove the device in the dashboard. If the server revokes the
token, the extension notices the next time it talks to the server (`401`, or close code
`4401`) and goes back to "Not paired".

## Using it

- **Popup:** shows the current state in large type (Not paired, Blocked: consent needed,
  Idle, Listening to this tab / microphone, Paused, Error). It has start/stop buttons for this
  tab and for the microphone, the elapsed time, a live caption from the server's `segment`
  messages, a **Copy "I'm recording" notice** button (the meeting-chat template in the UI
  language, plus the third-party-AI sentence when your server uses an external provider), and
  a link to the dashboard.
- **Shortcut:** `Alt+Shift+L` starts or stops recording the current tab. You can change it at
  `chrome://extensions/shortcuts`.
- **Meeting sites:** when a call starts, a small banner offers "Record this meeting with LTM?"
  with Start / Not now / Never on this site, and the badge shows a blue dot. Nothing is ever
  recorded automatically.
- **Microphone with tab audio** is on by default. With headphones, tab audio does not include
  your own voice. The server removes the duplicate audio (the tab stream wins).

## Permissions

| Permission                                                                                | Why                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabCapture`                                                                              | Capture the audio of the tab you chose to record.                                                                                                                                                                                           |
| `activeTab`                                                                               | Clicking the toolbar icon or pressing the shortcut grants access to _that_ tab: it allows `tabCapture` and lets the extension read the tab's title and hostname for the stream context. This avoids the `tabs` permission and `<all_urls>`. |
| `offscreen`                                                                               | MV3 workers have no audio APIs. An offscreen document (`USER_MEDIA`) owns the capture streams, the AudioWorklet and the WebSockets.                                                                                                         |
| `storage`                                                                                 | Server address, device token and preferences (`local`); capture state that must survive the worker being stopped (`session`).                                                                                                               |
| Content script on `meet.google.com`, `*.zoom.us`, `teams.microsoft.com`, `teams.live.com` | Detects that a call is in progress and shows the in-page banner. This list lives in one place: `src/shared/meetingHosts.ts`. The script sends only the tab title; the worker takes the hostname from the sender and never forwards the URL. |
| `optional_host_permissions` `https://*/*`, `http://*/*`                                   | Never granted in bulk. At pairing time the extension requests the **single origin** of your server, because extension pages need it to call the REST API.                                                                                   |

There is no `<all_urls>` and no `tabs`, `notifications`, `scripting` or remote code. The
extension pages' CSP is `script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`.

## Architecture

```
popup / options ──runtime messages──▶ service worker (state machine, badge, orchestration)
content script  ──────────────────────▶      │  chrome.storage.session: AppState
                                             ▼
                          offscreen document (USER_MEDIA) — opens the tab / mic stream
                          └─ @ltm/capture/browser startBrowserCapture():
                             MediaStream ─▶ AudioWorklet (downmix → windowed-sinc 16 kHz → 200 ms s16 blocks)
                                         ─▶ CaptureClock (context frame → device epoch ms)
                                         ─▶ CaptureSession: EnergyGate (silence dropped, DISCONTINUITY)
                                         ─▶ StreamClient (one WebSocket per source: hello → ready → frames …)
```

The audio pipeline and the stream client live in [`packages/capture`](../../packages/capture)
(`@ltm/capture`), shared with the web app and the capture agent. The extension adds the
Chrome-specific parts around it.

| Path | What |
| --- | --- |
| `src/background/` | Service worker. `machine.ts` is the pure reducer and view/badge logic. `controller.ts` handles capture start/stop, account refresh, tabs and commands. `offscreenHost.ts` manages the offscreen document's lifecycle. |
| `src/offscreen/` | Owns all audio. `media.ts` opens the tab stream (from `tabCapture`) or the microphone. `session.ts` is a thin adapter: it hands the stream to `startBrowserCapture` (with tab playthrough) and translates capture events into worker messages. `transcriber.ts` is the on-device STT hook (none ships). |
| `@ltm/capture/worklet` | The AudioWorklet module, emitted by `vite.config.ts` as its own file `capture-worklet.js`. |
| `src/popup/`, `src/options/`, `src/content/` | UI and the meeting-detection banner (plain TS with a small `h()` helper).                                                                                                                                             |
| `src/shared/`                                | Config/storage, REST client, URL helpers, message types, i18n dictionaries (EN/TR).                                                                                                                                   |
| `src/manifest.ts`                            | Generates `manifest.json` at build time.                                                                                                                                                                              |

### MV3 traps this code works around (search the source for the comments)

- The worker can be stopped after about 30 s idle. All state lives in `chrome.storage.session`.
  Listeners are registered synchronously at top level. Every read-modify-write of the state
  goes through one serial queue.
- Offscreen documents only get `chrome.runtime`, so the worker passes everything (server,
  token, tab stream id) in the start message. Only one offscreen document can exist, so
  `createDocument` calls are de-duplicated. A message sent right after creation can arrive
  before the listener exists, so sends are retried.
- `tabCapture` requires that you invoked the extension on that tab (toolbar click or
  shortcut). A click on a page element, including the extension's own banner, does not count.
  The banner says so and opens the popup where Chrome allows it.
- Capturing a tab mutes it for the user. The captured stream is played back through the
  speakers (`source → destination`).
- The AudioContext runs at the device rate, not 16 kHz, so the meeting you hear is not
  band-limited. An AudioWorklet node is only processed when it leads to the destination, so it
  has one silent output connected there.
- Per-tab badge values override the global badge and stay set until the tab navigates.
  Only global badge values are used, so a stale per-tab value can never hide REC.
- `chrome.permissions.request` must run before the first `await` in the click handler.
- The service worker cannot use dynamic `import()`. Vite's module-preload helper, which
  touches `document`, is disabled so it cannot end up in chunks shared with the worker.
- Content scripts cannot be ES modules, and the worklet runs in a scope without DOM or
  `chrome`. Both are built as separate self-contained bundles (see `vite.config.ts`).

## Wire behaviour (summary)

- One socket per source (`tab` and `mic` each get their own UUID v4 `streamId`). `hello` is the
  first message and carries the token, never in the URL. No frame is sent before `ready`.
  The client sends `ping` every 15 s. Any message counts as liveness; after 45 s with no
  message the client reconnects. On stop it sends `end` and waits for `closed` (up to 15 s).
- Frames: 200 ms of 16 kHz mono `pcm_s16le`, encoded with `encodeAudioFrame`. `seq` is
  assigned when the frame is produced. `captureTimeMs` is the device-clock time of the first
  sample, derived from the AudioContext frame position. It is anchored to `Date.now()` once
  and then slewed to follow drift (at most 2 ms per second). Larger jumps are stepped and
  flagged.
- Gate: about 800 ms hangover, 400 ms pre-roll, a threshold that follows the noise floor
  (capped so normal speech always passes), and `DISCONTINUITY` on the first frame after
  dropped silence.
- Reconnect: exponential back-off with jitter (0.5 s doubling up to 30 s), resuming the same
  `streamId`. While disconnected, up to 60 s of audio is buffered. Beyond that the oldest
  frames are dropped and the next frame is flagged.
- Fatal errors stop the stream and update the UI: `unauthorized` un-pairs,
  `consent_required` shows "Blocked: consent needed", `ingest_paused` shows "Paused",
  `unsupported_protocol` shows an update message. Transient errors (`rate_limited`,
  `internal`, `conflict`, …) are retried.

## Tests

```sh
pnpm --filter @ltm/extension typecheck   # three tsconfigs: pages (DOM), worker (WebWorker), tests
pnpm --filter @ltm/extension test        # vitest: state machine, adapter, manifest, i18n, API client
pnpm --filter @ltm/capture test          # the shared pipeline: DSP, gate, clock, stream client, Node e2e
pnpm --filter @ltm/extension build
node apps/extension/scripts/browser-check.mjs [screenshotDir]   # needs a built dist/ and a global Playwright
```

`browser-check.mjs` loads `dist/` into Playwright's Chromium with a fake LTM server.
It checks that the worker registers, renders the settings page and popup in EN and TR
(screenshots), and runs the consent flow through the UI. It then records from Chromium's fake
microphone (getUserMedia → worklet → gate → WebSocket) and checks the frames, the REC badge,
the live caption and stop/`closed`. It also checks fatal-error handling, token revocation and
the meeting banner on a stand-in Meet page.

## Known limitations

- **Real tab capture is not covered by automated tests.** `tabCapture` needs a real click on
  the toolbar icon or the shortcut, which headless automation cannot produce. The tab path
  shares everything after `getUserMedia` with the microphone path, which is tested in a real
  Chromium.
- **On-device transcription is not available yet.** The plumbing exists: `mode: "transcript"`
  streams, `transcript` messages, the `Transcriber` interface, speech windowing and a
  `POST /ingest/transcripts` fallback. No speech recogniser ships, and the setting is shown
  disabled as "experimental — not available yet".
- Meeting detection is heuristic: "leave/hang up" controls in EN/TR, plus each platform's
  stable attributes. A miss only means you click the icon. A false positive only shows a
  dismissible banner.
- A meeting that ends in the recorded tab (detected after about 10 s), leaving the site, or
  closing the tab stops the recording. Navigating within the same site keeps it running.
- Frames that were already handed to a socket that then died are not re-sent, because the
  protocol does not say the server de-duplicates by `seq`. The next frame is flagged as a
  discontinuity instead.
- Microphone input latency (about 10–40 ms) is not subtracted from the timestamps. The
  server's merge tolerance absorbs it.
- Pairing needs Chrome's host-permission prompt for your server. If you decline it, the
  extension cannot reach the REST API.
