# Contributing to LTM

Thanks for wanting to help. LTM records and remembers people's conversations, so the bar
for privacy and correctness is high — and contributions that raise it are especially
welcome.

## Before you start

- **License.** LTM is source-available under the PolyForm Noncommercial License
  ([`LICENSE`](LICENSE), summary in [`LICENSING.md`](LICENSING.md)). It is not an
  OSI-approved open-source license. By contributing you agree that your work is published
  under it and can also be offered by the licensor under commercial terms.
- **Contributor License Agreement.** Your first pull request must include the statement
  from [`CLA.md`](CLA.md) (it is a checkbox in the PR template), and commits must be
  signed off (`git commit -s`). Without it we cannot merge. You keep your copyright.
- **Code of conduct.** Participation is governed by
  [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
- **Talk first for big changes.** Open an issue before investing in a new capture client,
  a protocol change, a new provider, or anything touching consent or data retention.

## Ground rules that are specific to this project

1. **Never commit real recordings, transcripts or personal data.** Test fixtures must be
   synthetic (generated tones, invented dialogue with invented names). This includes
   screenshots and logs in issues and pull requests.
2. **Never commit secrets.** No API keys, tokens, passwords, signing identities or team
   ids — not in code, tests, docs, commit messages or CI logs. Run `pnpm check:secrets`
   before pushing; CI runs it too. If you leak a credential, revoke it first, then tell a
   maintainer.
3. **Consent and capture indicators are not optional features.** Changes must not make it
   possible to capture before the consent documents are accepted, weaken the server-side
   consent check, hide or remove the visible "capturing" state of a client, or auto-start
   recording without a user action. Changes to the consent texts in
   `packages/protocol/consent/` need a version bump and a maintainer's review.
4. **Privacy defaults stay conservative.** Audio is deleted after transcription unless
   the user opts in; nothing phones home; no analytics, telemetry, remote fonts or CDNs;
   new outbound network destinations must be user-configured and documented.
5. **Do not log content.** Transcript text, prompts, tokens and keys must never reach
   logs above `debug`.
6. **Protocol changes are compatibility changes.** `packages/protocol` is the contract
   between the server and every client, including apps already installed on phones.
   Additive changes are fine; anything breaking needs a `PROTOCOL_VERSION` bump and a
   migration story.

## Development setup

Requirements: Node.js 22+, pnpm 10+. For the Apple apps: a Mac with Xcode 16+ and
[XcodeGen](https://github.com/yonaskolb/XcodeGen).

```bash
pnpm install
```

```bash
pnpm dev
```

`pnpm dev` starts the server on `http://localhost:8080` (embedded database under
`apps/server/data`, no external services needed) and the web app on
`http://localhost:5173`. Without any model configured the server still accepts audio and
stores it; configure providers in **Settings → AI providers**, or see
[`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) for a fully local setup.

| Task | Command |
| --- | --- |
| Type-check everything | `pnpm typecheck` |
| Run all tests | `pnpm test` |
| Lint / format | `pnpm lint` / `pnpm format` |
| Build everything | `pnpm build` |
| Scan for secrets | `pnpm check:secrets` |
| Work on one package | `pnpm --filter @ltm/server test` (or `@ltm/web`, `@ltm/extension`, `@ltm/core`, `@ltm/providers`, `@ltm/protocol`) |

Where things live is described in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Each
app has its own README with details (loading the extension unpacked, generating the Xcode
project, adding a database migration).

## Pull requests

- Keep them focused; one concern per PR.
- Add or update tests. The merge algorithm (`packages/core`) and the ingest pipeline are
  only changed together with tests that show the new behaviour.
- User-facing strings exist in English **and** Turkish; add both.
- Update docs when behaviour, configuration or the protocol changes.
- Describe how you tested. For capture clients, say on which browser/OS/device.
- Disclose substantial AI-generated portions (see the CLA) — and review them as carefully
  as you would review a stranger's code.

## Reporting bugs and security issues

Bugs: open an issue using the template — without real transcripts or audio.
Security or privacy vulnerabilities: **do not open a public issue**; follow
[`SECURITY.md`](SECURITY.md).
