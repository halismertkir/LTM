#!/usr/bin/env node
// Fails when something that looks like a credential is tracked or staged.
// Run locally (`pnpm check:secrets`) and in CI. Patterns are deliberately broad.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI API key", /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["Private key block", /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{36,}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
];

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

let failed = false;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue; // binary
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const [name, re] of PATTERNS) {
      if (re.test(lines[i])) {
        console.error(`${file}:${i + 1}: possible ${name}`);
        failed = true;
      }
    }
  }
}
if (failed) {
  console.error("\nPotential secrets found. Remove them before committing.");
  process.exit(1);
}
console.log(`check-secrets: ${files.length} files scanned, nothing found.`);
