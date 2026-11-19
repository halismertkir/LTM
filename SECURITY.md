# Security policy

LTM handles some of the most sensitive data a person has: recordings and transcripts of
their conversations. Please report anything that could expose that data.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security or privacy
problem.** Use GitHub's private vulnerability reporting instead: the repository's
**Security** tab → **Report a vulnerability**.

Please include what you found, how to reproduce it, the affected component (server, web,
extension, iOS, watchOS) and version or commit. **Never include real recordings,
transcripts, tokens or other people's personal data** — a synthetic reproduction is
enough.

You can expect an acknowledgement within a few days. We will keep you informed while we
work on a fix, credit you in the release notes if you wish, and ask that you give us a
reasonable time to release a fix before disclosing publicly.

## In scope

- Authentication, session and device-token handling; pairing.
- Cross-account access to conversations, memories, audio or settings.
- Bypasses of the consent gate or the capture kill switch.
- Leakage of API keys or other secrets (at rest, in logs, in responses, in exports).
- Injection through transcript content (for example a spoken instruction steering the
  note-taking model into harmful actions, or markup in notes executing in the web app).
- Capture clients recording or transmitting without the visible indicator, or to a host
  the user did not configure.

## Out of scope

- Vulnerabilities in third-party model providers or in models themselves.
- Self-hosted deployments that are misconfigured contrary to
  [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) (for example exposing the server to the
  internet over plain HTTP).
- Social-engineering and physical attacks.

## Supported versions

Until the first stable release, only the latest commit on the default branch receives
security fixes.
