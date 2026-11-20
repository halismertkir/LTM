# LTM capture agent (`@ltm/agent`)

`ltm-agent` is a headless daemon that streams an always-on microphone (a desk or room
microphone, or any ffmpeg input) to your LTM server. Use it when a machine that is on all
day should listen without a browser open: a home server, a desktop PC or a Mac mini.

It uses the same capture pipeline as the browser clients (`@ltm/capture`). ffmpeg delivers
16 kHz mono PCM, and the agent stamps it with wall-clock capture times. It drops silence
with an energy gate and streams 200 ms frames over the resumable ingest WebSocket.

> **People near the microphone must know they are being recorded.** An always-on
> microphone captures everyone in the room: family, guests, colleagues, children. In many
> places recording people without their knowledge or consent is illegal. Tell everyone, put
> up a visible notice, pause capture when someone objects, and never use the agent to
> monitor anyone secretly. Read [docs/legal/CONSENT.md](../../docs/legal/CONSENT.md) before
> setting it up. The agent makes you accept the consent documents yourself
> (`ltm-agent consent`), but it cannot tell the people around you.

## Install

You need **Node 22+** and **ffmpeg** on `PATH` (`apt install ffmpeg`,
`brew install ffmpeg`, or `winget install ffmpeg`). There are no native modules.

```sh
pnpm --filter @ltm/agent build          # → apps/agent/dist/ltm-agent.mjs (single file)
install -m 755 apps/agent/dist/ltm-agent.mjs ~/.local/bin/ltm-agent
ltm-agent --version
```

The built file runs anywhere Node 22 runs. Copy it to the machine with the microphone.
On Windows, run it as `node ltm-agent.mjs …`.

## Pair

In the dashboard, open **Devices → Pair a device**, create a code, then run:

```sh
ltm-agent pair --server https://ltm.example.org --code K7QF-2MXD --name "Living room"
```

- This registers a `desktop` device and stores `{ serverUrl, token, deviceId }` in
  `$XDG_CONFIG_HOME/ltm-agent/config.json` (default `~/.config/ltm-agent/config.json`;
  `%APPDATA%\ltm-agent\config.json` on Windows). The file is created with mode `0600`
  and the token is never printed. Override the path with `--config <path>` or
  `LTM_AGENT_CONFIG`.
- The agent refuses plain `http://` to anything other than localhost, because the token
  and audio would travel unencrypted. Pass `--insecure-http` only on a network you trust.
- It checks `/version` first and stops with a clear message on a protocol mismatch.

`ltm-agent unpair` deletes the stored token. To revoke the token on the server, remove the
device in the dashboard.

## Consent

```sh
ltm-agent consent            # --lang en|tr (default: from $LANG)
```

If the server needs consent, the agent prints every required document from
`@ltm/protocol` in full. You accept each one by typing the confirmation phrase (`I agree`
or `Kabul ediyorum`); anything else cancels and nothing is recorded. There is
deliberately no `--yes` option. If everything is already accepted, the command says so.

## Run

```sh
ltm-agent run                                  # default microphone, until Ctrl-C / SIGTERM
ltm-agent run --source ambient --language tr --title "Living room" --captions
ltm-agent run --file meeting.m4a --title "Import"   # a recording, read at real-time speed
ltm-agent status                               # server, device, consent, capture state
```

| Option | Meaning |
| --- | --- |
| `--source mic\|ambient` | `mic` (default) is a microphone close to you. `ambient` is a far-field room microphone, which ranks lower when several devices heard the same speech. |
| `--language <tag>` | Spoken-language hint for the server's speech-to-text, e.g. `tr`, `en-US`. Omit it for auto-detection. |
| `--title <text>` | Stream context shown with the conversation (default `ltm-agent on <hostname>`). |
| `--input "<args>"` | ffmpeg input arguments, replacing the platform default (see below). |
| `--file <path>` | Read a media file with `-re` (at real-time speed) instead of a device. The stream ends at the end of the file. |
| `--captions` | Print live captions from the server to stderr. |
| `--verbose` | Also log levels, re-anchoring and non-fatal stream errors. |
| `--ffmpeg <path>` | ffmpeg binary (`LTM_AGENT_FFMPEG`). |

The agent logs state changes to stderr (`connecting`, `streaming`,
`reconnecting (N s of audio buffered)`, `ending`, `ended`). It never logs audio or tokens.

- **Network loss:** the stream reconnects with back-off and resumes the same stream id
  for the life of the process. Up to 60 s of audio is buffered meanwhile.
- **ffmpeg dies** (device unplugged, audio server restarted): ffmpeg is restarted with
  back-off (1 s doubling up to 30 s), and the first new frame is flagged as a
  discontinuity.
- **Stopping:** SIGINT or SIGTERM sends `end` and waits for `closed`. A second Ctrl-C
  exits at once.

| Exit code | Meaning |
| --- | --- |
| 0 | Stopped cleanly (signal, or end of `--file`). |
| 1 | Runtime failure (ffmpeg missing or failing, server ended the stream, unreachable at pairing). |
| 2 | Usage or configuration error (bad option, not paired, no default input on Windows). |
| 3 | A person has to act: `consent_required` (run `ltm-agent consent`), `ingest_paused` (resume capture in the dashboard), `unauthorized` (device removed: pair again). |

### Timestamps

Each frame carries the wall-clock time of its first sample.

- **Anchor:** the agent anchors the first sample to the wall clock, then advances by sample
  count. The anchor is the tightest bound the arrivals allow, observed over a 0.6 s warm-up,
  because a sample cannot arrive before it was captured. This absorbs ffmpeg's start-up
  burst: it delivers about the first 0.5 s of a file or device buffer at once.
- **Drift:** if sample time and wall clock drift apart by more than 1.5 s (ffmpeg stalled,
  laptop suspended), the stream is re-anchored and flagged as a discontinuity.
- **Restart:** an ffmpeg restart also starts a new anchor.

## Choosing the microphone

`ltm-agent devices` lists the capture devices ffmpeg can see (best effort). Pass one with
`--input`:

| Platform | Default | Pick another |
| --- | --- | --- |
| Linux (PulseAudio / PipeWire) | `-f pulse -i default` | `--input "-f pulse -i alsa_input.usb-…"` (names from `pactl list short sources`) |
| Linux (ALSA only) | — | `--input "-f alsa -i hw:1"` or `"-f alsa -i default"` |
| macOS | `-f avfoundation -i :0` | `--input "-f avfoundation -i :1"` (index from `ltm-agent devices`) |
| Windows | none: a device name is required | `--input '-f dshow -i audio="Microphone (USB Audio)"'` |

The agent splits `--input` like a shell, so quote names that contain spaces. The output side
is always `-vn -ac 1 -ar 16000 -acodec pcm_s16le -f s16le pipe:1`.

## Run as a service

**Linux (systemd user unit):** see [`systemd/ltm-agent.service`](systemd/ltm-agent.service).
It runs in your user session so it can reach PulseAudio/PipeWire.

```sh
mkdir -p ~/.config/systemd/user && cp systemd/ltm-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ltm-agent
loginctl enable-linger "$USER"          # keep running after logout
journalctl --user -u ltm-agent -f
```

The unit uses `Restart=always` with `RestartPreventExitStatus=2 3`. Configuration problems
and "consent / paused / removed" therefore do not restart in a loop: fix them, then run
`systemctl --user restart ltm-agent`.

**macOS (launchd):** see [`launchd/org.ltm.agent.plist`](launchd/org.ltm.agent.plist).
Adjust the paths and load it with `launchctl bootstrap gui/$(id -u) …`. macOS asks for
microphone permission on the first run.

**Windows:** run `node ltm-agent.mjs run --input '-f dshow -i audio="…"'` from Task Scheduler
("At log on", restart on failure), or wrap it with a service manager such as NSSM.

## Development

```sh
pnpm --filter @ltm/agent typecheck
pnpm --filter @ltm/agent test     # unit tests + the real CLI with ffmpeg against a local ws server
pnpm --filter @ltm/agent build
node scripts/e2e/agent.mjs        # built agent ↔ built server (needs `pnpm build` first)
```

## Limitations

- The device defaults (`-f pulse`, `-f alsa`, `-f avfoundation`, `-f dshow`) are not
  covered by automated tests, which use `--file` and a fake ffmpeg process. Verify your
  device with `ltm-agent devices` and a short `ltm-agent run --captions`.
- On-device transcription is not offered. The agent always streams audio, mode `audio`.
- Microphone input latency is not subtracted from timestamps. The warm-up anchor bounds the
  error to the device's buffering, typically tens of milliseconds.
