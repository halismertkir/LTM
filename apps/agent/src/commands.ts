import { spawn } from "node:child_process";
import { arch, hostname, platform } from "node:os";
import { CONSENT_DOCUMENTS, PROTOCOL_VERSION } from "@ltm/protocol";
import { AgentApi, ApiError, isInsecureRemote, normalizeServerUrl } from "./api.js";
import type { Command, Lang } from "./args.js";
import { type AgentConfig, deleteConfig, loadConfig, saveConfig } from "./config.js";
import { listDevicesArgs } from "./ffmpeg.js";

export const AGENT_VERSION = "0.1.0";

/** Exit codes (the systemd unit does not restart on 2 and 3: a human has to act). */
export const EXIT = { OK: 0, FAILURE: 1, USAGE: 2, NEEDS_USER: 3 } as const;

/** Terminal I/O, injectable for tests. Everything goes to stderr except command results. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Reads one line from stdin; null at end of input. */
  ask(prompt: string): Promise<string | null>;
}

export function requireConfig(path: string, io: Io): AgentConfig | null {
  const cfg = loadConfig(path);
  if (!cfg)
    io.err(`Not paired (no config at ${path}). Run: ltm-agent pair --server <url> --code <code>`);
  return cfg;
}

function apiErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "network" || err.code === "timeout")
      return `cannot reach the server (${err.message})`;
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ------------------------------------------------------------------------------- pair

export async function pairCommand(
  cmd: Extract<Command, { name: "pair" }>,
  configPath: string,
  io: Io,
): Promise<number> {
  let serverUrl: string;
  try {
    serverUrl = normalizeServerUrl(cmd.server);
  } catch (err) {
    io.err(`Invalid --server: ${(err as Error).message}`);
    return EXIT.USAGE;
  }
  if (isInsecureRemote(serverUrl) && !cmd.insecureHttp) {
    io.err(
      `Refusing plain http to ${new URL(serverUrl).host}: the device token and your audio would travel unencrypted.\n` +
        "Use https, or pass --insecure-http if this is a trusted private network.",
    );
    return EXIT.USAGE;
  }
  const api = new AgentApi(serverUrl);
  try {
    const v = await api.version();
    if (v.protocol !== PROTOCOL_VERSION) {
      io.err(
        `Protocol mismatch: the server speaks version ${v.protocol}, this agent speaks ${PROTOCOL_VERSION}. Update the older one.`,
      );
      return EXIT.FAILURE;
    }
  } catch (err) {
    io.err(`No LTM server answered at ${serverUrl}: ${apiErrorText(err)}`);
    return EXIT.FAILURE;
  }
  const name = cmd.deviceName ?? `ltm-agent on ${hostname()}`.slice(0, 80);
  try {
    const res = await api.pair({
      code: cmd.code.trim(),
      name,
      kind: "desktop",
      platform: `${platform()} ${arch()}`.slice(0, 80),
      appVersion: AGENT_VERSION,
    });
    saveConfig(configPath, {
      serverUrl,
      token: res.token,
      deviceId: res.device.id,
      deviceName: res.device.name,
      pairedAt: new Date().toISOString(),
    });
    io.out(
      `Paired with ${serverUrl} as "${res.device.name}" (device ${res.device.id}) for ${res.user.displayName}.`,
    );
    io.out(`Credentials saved to ${configPath} (readable only by you).`);
    io.out("Next: ltm-agent consent   (then: ltm-agent run)");
    return EXIT.OK;
  } catch (err) {
    if (
      err instanceof ApiError &&
      ["not_found", "unauthorized", "bad_request", "conflict", "forbidden"].includes(err.code)
    ) {
      io.err(
        "The pairing code was not accepted. Codes are single-use and expire after 10 minutes; create a new one in the dashboard.",
      );
    } else {
      io.err(`Pairing failed: ${apiErrorText(err)}`);
    }
    return EXIT.FAILURE;
  }
}

// ---------------------------------------------------------------------------- consent

const CONFIRM: Record<
  Lang,
  { phrase: string; prompt: (title: string) => string; text: Record<string, string> }
> = {
  en: {
    phrase: "I agree",
    prompt: (t) => `Type "I agree" to accept "${t}" (anything else cancels): `,
    text: {
      satisfied: "Consent: all required documents are accepted.",
      required:
        "Your LTM server requires you to accept the following documents before anything is recorded.",
      cancelled:
        "Not accepted. Nothing was recorded or sent; run `ltm-agent consent` again when you are ready.",
      accepted: "Thank you — consent recorded on the server. You can now run: ltm-agent run",
      mismatch:
        'The server asks for version {server} of "{title}", but this agent contains version {local}. Accept it in the dashboard or update the agent.',
    },
  },
  tr: {
    phrase: "Kabul ediyorum",
    prompt: (t) =>
      `"${t}" belgesini kabul etmek için "Kabul ediyorum" yazın (başka her şey iptal eder): `,
    text: {
      satisfied: "Onay: gerekli tüm belgeler kabul edildi.",
      required:
        "LTM sunucunuz, herhangi bir kayıt yapılmadan önce aşağıdaki belgeleri kabul etmenizi istiyor.",
      cancelled:
        "Kabul edilmedi. Hiçbir şey kaydedilmedi veya gönderilmedi; hazır olduğunuzda `ltm-agent consent` komutunu yeniden çalıştırın.",
      accepted:
        "Teşekkürler — onayınız sunucuya kaydedildi. Artık şunu çalıştırabilirsiniz: ltm-agent run",
      mismatch:
        'Sunucu "{title}" belgesinin {server} sürümünü istiyor, ancak bu ajanda {local} sürümü var. Panelden kabul edin veya ajanı güncelleyin.',
    },
  },
};

/** Consent documents are Markdown; in a terminal, drop the emphasis markers only. */
export function markdownToText(md: string): string {
  return md.replace(/\*\*([^*]+)\*\*/g, "$1");
}

export async function consentCommand(
  cmd: Extract<Command, { name: "consent" }>,
  configPath: string,
  io: Io,
): Promise<number> {
  const cfg = requireConfig(configPath, io);
  if (!cfg) return EXIT.USAGE;
  const api = new AgentApi(cfg.serverUrl, cfg.token);
  const L = CONFIRM[cmd.lang];
  let me: Awaited<ReturnType<AgentApi["me"]>>;
  try {
    me = await api.me();
  } catch (err) {
    if (err instanceof ApiError && err.code === "unauthorized") {
      io.err(
        "This device's token was revoked. Pair again: ltm-agent pair --server <url> --code <code>",
      );
      return EXIT.NEEDS_USER;
    }
    io.err(`Could not load your consent status: ${apiErrorText(err)}`);
    return EXIT.FAILURE;
  }
  if (me.consent.satisfied) {
    io.out(L.text.satisfied!);
    return EXIT.OK;
  }
  const pending = me.consent.required.filter((r) => !r.accepted);
  io.out(L.text.required!);
  const accept: { type: (typeof pending)[number]["type"]; version: string }[] = [];
  for (const req of pending) {
    const doc = CONSENT_DOCUMENTS.find((d) => d.type === req.type);
    if (!doc || doc.version !== req.version) {
      io.err(
        L.text
          .mismatch!.replace("{server}", req.version)
          .replace("{title}", doc?.[cmd.lang].title ?? req.type)
          .replace("{local}", doc?.version ?? "—"),
      );
      return EXIT.FAILURE;
    }
    const text = doc[cmd.lang];
    io.out("");
    io.out(`━━ ${text.title} (${doc.version}) ━━`);
    io.out("");
    io.out(markdownToText(text.body));
    io.out("");
    // Never auto-accepted: each document needs the phrase typed by a person.
    const answer = await io.ask(L.prompt(text.title));
    if (
      answer === null ||
      answer.trim().toLocaleLowerCase(cmd.lang) !== L.phrase.toLocaleLowerCase(cmd.lang)
    ) {
      io.err(L.text.cancelled!);
      return EXIT.NEEDS_USER;
    }
    accept.push({ type: req.type, version: req.version });
  }
  try {
    const state = await api.acceptConsents({ accept });
    if (!state.satisfied) {
      io.err(
        "The server recorded the acceptance but still reports missing consent; check the dashboard.",
      );
      return EXIT.FAILURE;
    }
  } catch (err) {
    io.err(`Could not record consent: ${apiErrorText(err)}`);
    return EXIT.FAILURE;
  }
  io.out(L.text.accepted!);
  return EXIT.OK;
}

// ----------------------------------------------------------------------------- status

export async function statusCommand(configPath: string, io: Io): Promise<number> {
  const cfg = requireConfig(configPath, io);
  if (!cfg) return EXIT.USAGE;
  io.out(`Config:  ${configPath}`);
  io.out(`Server:  ${cfg.serverUrl}`);
  io.out(`Device:  ${cfg.deviceName ?? "?"} (${cfg.deviceId})`);
  const api = new AgentApi(cfg.serverUrl, cfg.token);
  try {
    const [v, dev, me] = await Promise.all([api.version(), api.deviceSelf(), api.me()]);
    io.out(
      `LTM:     ${v.version} (protocol ${v.protocol}${v.protocol === PROTOCOL_VERSION ? "" : `, agent speaks ${PROTOCOL_VERSION}!`})`,
    );
    io.out(
      `Name:    ${dev.name} · access ${dev.access} · ${dev.online ? "streaming now" : "not streaming"}`,
    );
    io.out(`Account: ${me.user.displayName}`);
    io.out(
      `Consent: ${me.consent.satisfied ? "all required documents accepted" : "MISSING — run: ltm-agent consent"}`,
    );
    io.out(
      `Capture: ${me.ingestPaused ? "PAUSED for your account (resume in the dashboard)" : "allowed"}`,
    );
    return me.consent.satisfied && !me.ingestPaused ? EXIT.OK : EXIT.NEEDS_USER;
  } catch (err) {
    if (err instanceof ApiError && err.code === "unauthorized") {
      io.err("The server rejected this device's token (removed in the dashboard?). Pair again.");
      return EXIT.NEEDS_USER;
    }
    io.err(`Server:  ${apiErrorText(err)}`);
    return EXIT.FAILURE;
  }
}

// ---------------------------------------------------------------------------- devices

export async function devicesCommand(ffmpegPath: string, io: Io): Promise<number> {
  const runs = listDevicesArgs();
  let any = false;
  for (const args of runs) {
    const output = await new Promise<string | null>((resolve) => {
      let text = "";
      const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (c: Buffer) => (text += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (text += c.toString("utf8")));
      child.on("error", () => resolve(null));
      child.on("close", () => resolve(text));
    });
    if (output === null) {
      io.err(`ffmpeg not found ("${ffmpegPath}"). Install it or pass --ffmpeg <path>.`);
      return EXIT.FAILURE;
    }
    any = true;
    io.out(`$ ffmpeg ${args.map((a) => (a === "" ? '""' : a)).join(" ")}`);
    io.out(output.trim() || "(no output)");
    io.out("");
  }
  if (any) {
    const example =
      process.platform === "linux"
        ? '--input "-f pulse -i <source name>"   or   --input "-f alsa -i hw:1"'
        : process.platform === "darwin"
          ? '--input "-f avfoundation -i :<audio index>"'
          : process.platform === "win32"
            ? "--input '-f dshow -i audio=\"<device name>\"'"
            : '--input "<ffmpeg input args>"';
    io.out(`Pick a device and pass it to run: ltm-agent run ${example}`);
  }
  return EXIT.OK;
}

// ----------------------------------------------------------------------------- unpair

export function unpairCommand(configPath: string, io: Io): number {
  const cfg = loadConfig(configPath);
  const removed = deleteConfig(configPath);
  if (!removed) {
    io.out(`Not paired (no config at ${configPath}).`);
    return EXIT.OK;
  }
  io.out(`Removed ${configPath}; the device token is gone from this machine.`);
  if (cfg) {
    io.out(
      `To revoke the token on the server as well, remove the device "${cfg.deviceName ?? cfg.deviceId}" in the dashboard (Devices).`,
    );
  }
  return EXIT.OK;
}
