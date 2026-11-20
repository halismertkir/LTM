import { createInterface } from "node:readline";
import { parseArgs, USAGE, UsageError } from "./args.js";
import {
  AGENT_VERSION,
  consentCommand,
  devicesCommand,
  EXIT,
  type Io,
  pairCommand,
  requireConfig,
  statusCommand,
  unpairCommand,
} from "./commands.js";
import { ConfigError, resolveConfigPath } from "./config.js";
import { type RunDeps, runCommand } from "./run.js";

/** Line reader over stdin that works for a terminal and for piped input alike. */
function stdinIo(): Io {
  let rl: ReturnType<typeof createInterface> | null = null;
  const lines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  const ensure = () => {
    if (rl) return;
    rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => {
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    });
    rl.on("close", () => {
      closed = true;
      for (const w of waiters.splice(0)) w(null);
    });
  };
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    ask: (prompt) => {
      ensure();
      process.stderr.write(prompt);
      const queued = lines.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

export async function main(argv: string[], deps: Partial<RunDeps> = {}): Promise<number> {
  const io = deps.io ?? stdinIo();
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv, process.env);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`ltm-agent: ${err.message}`);
      return EXIT.USAGE;
    }
    throw err;
  }
  const { command } = parsed;
  const configPath = resolveConfigPath(parsed.configPath);
  try {
    switch (command.name) {
      case "help":
        io.out(USAGE);
        return EXIT.OK;
      case "version":
        io.out(`ltm-agent ${AGENT_VERSION}`);
        return EXIT.OK;
      case "pair":
        return await pairCommand(command, configPath, io);
      case "consent":
        return await consentCommand(command, configPath, io);
      case "status":
        return await statusCommand(configPath, io);
      case "devices":
        return await devicesCommand(command.ffmpeg ?? "ffmpeg", io);
      case "unpair":
        return unpairCommand(configPath, io);
      case "run": {
        const cfg = requireConfig(configPath, io);
        if (!cfg) return EXIT.USAGE;
        return await runCommand(command, cfg, { signals: process, ...deps, io });
      }
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      io.err(`ltm-agent: ${err.message}`);
      return EXIT.USAGE;
    }
    throw err;
  }
}
