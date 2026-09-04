# Security Policy

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting flow](https://github.com/ArtMoreno/ScriptSurgeon/security/advisories/new) for issues that could expose recordings, transcripts, project files, session tokens, local paths, or arbitrary filesystem/process access.

Include the affected version or commit, operating system, impact, and minimal reproduction steps. Remove private media, credentials, tokens, personal paths, and real project data before submitting the report.

Do not open a public issue for an unpatched vulnerability. Maintainers will acknowledge the report through GitHub and coordinate validation, a fix, and disclosure there.

## Supported versions

Security fixes target the latest release and the current default branch. Users should update to the newest available release after a fix is published.

## Local security boundaries

ScriptSurgeon's desktop backend is intended to listen only on the loopback interface. The launcher uses a random per-session token for local API access, validates trusted local hosts, and stores projects and diagnostics on the device. Reports that show a bypass of those boundaries are especially valuable.
