import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderKind } from "@ltm/protocol";
import { ProviderError } from "./types.js";
import { abortedError, deadline } from "./util.js";

export interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CliInvocation {
  provider: ProviderKind;
  binary: string;
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Output beyond this is dropped (a runaway process cannot exhaust memory). */
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

const KILL_GRACE_MS = 2000;

/**
 * Environment for a vendor CLI: the owner's own (HOME, PATH, the CLI's login), minus
 * this server's secrets — the CLI has no business seeing them even with tools off.
 */
export function cliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.startsWith("LTM_") || k === "DATABASE_URL" || k === "PGPASSWORD") continue;
    // Set inside a Claude Code session; would make the child believe it is nested.
    if (k === "CLAUDECODE") continue;
    env[k] = v;
  }
  env.NO_COLOR = "1";
  return env;
}

/** A fresh empty working directory, removed afterwards: the CLI never sees server files. */
export async function withScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ltm-cli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Runs a binary without a shell; the prompt goes over stdin, never through argv. */
export function runCli(inv: CliInvocation): Promise<CliRun> {
  const max = inv.maxOutputBytes ?? 16 * 1024 * 1024;
  const dl = deadline(inv.timeoutMs, inv.signal);
  return new Promise<CliRun>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      dl.dispose();
      fn();
    };
    if (dl.signal.aborted) {
      finish(() => reject(abortedError(inv.provider, dl.timedOut(), inv.timeoutMs)));
      return;
    }
    const child = spawn(inv.binary, inv.args, {
      cwd: inv.cwd,
      env: inv.env ?? cliEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    child.stdout.on("data", (b: Buffer) => {
      if (outBytes < max) out.push(b);
      outBytes += b.length;
    });
    child.stderr.on("data", (b: Buffer) => {
      if (errBytes < 1024 * 1024) err.push(b);
      errBytes += b.length;
    });
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    dl.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e: NodeJS.ErrnoException) => {
      finish(() => {
        if (e.code === "ENOENT") {
          reject(
            new ProviderError(
              inv.provider,
              "not_configured",
              `the \`${inv.binary}\` CLI was not found on the server (is it installed and on PATH?)`,
              { cause: e },
            ),
          );
        } else if (e.code === "EACCES") {
          reject(
            new ProviderError(
              inv.provider,
              "not_configured",
              `the \`${inv.binary}\` CLI is not executable`,
              { cause: e },
            ),
          );
        } else {
          reject(
            new ProviderError(
              inv.provider,
              "unavailable",
              `could not start \`${inv.binary}\`: ${e.message}`,
              { cause: e },
            ),
          );
        }
      });
    });
    child.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      dl.signal.removeEventListener("abort", onAbort);
      finish(() => {
        if (dl.signal.aborted) {
          reject(abortedError(inv.provider, dl.timedOut(), inv.timeoutMs));
          return;
        }
        resolve({
          code,
          signal,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
      });
    });
    child.stdin.on("error", () => {
      // The CLI may exit before reading all of stdin (e.g. not logged in); its exit status says why.
    });
    child.stdin.end(inv.stdin, "utf8");
  });
}

const NOT_LOGGED_IN =
  /not logged in|please run \/?login|log ?in (again|first|required)|invalid api key|authentication[_ ](failed|error)|unauthori[sz]ed|\b401\b|oauth token (has )?expired|credentials? (not found|missing|expired)/i;
const RATE_LIMITED =
  /rate.?limit|usage limit|too many requests|\b429\b|quota|limit reached|overloaded/i;

/** Turns a failed CLI run into a ProviderError the settings page can explain. */
export function cliFailure(
  provider: ProviderKind,
  binary: string,
  detail: string,
  loginHint: string,
): ProviderError {
  const text = detail.replace(/\s+/g, " ").trim();
  if (NOT_LOGGED_IN.test(text)) {
    return new ProviderError(
      provider,
      "auth",
      `the \`${binary}\` CLI is not logged in on the server host. ${loginHint}`,
    );
  }
  if (RATE_LIMITED.test(text)) {
    return new ProviderError(
      provider,
      "rate_limited",
      `the \`${binary}\` CLI hit a usage or rate limit`,
    );
  }
  return new ProviderError(
    provider,
    "unknown",
    `the \`${binary}\` CLI failed${text ? `: ${text.slice(0, 300)}` : ""}`,
    { retryable: true },
  );
}
