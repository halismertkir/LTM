// Entry point of the bundled CLI (dist/ltm-agent.mjs).
import { main } from "./cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // stdin may hold the event loop open after `consent`; nothing else is pending here.
    process.stdin.unref?.();
  },
  (err: unknown) => {
    process.stderr.write(
      `ltm-agent: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  },
);
