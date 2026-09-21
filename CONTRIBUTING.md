# Contributing to ScriptSurgeon

Thank you for helping improve a private, local-first audio editor.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Keep changes focused. Separate product behavior, packaging, and visual changes when practical.
- Never commit recordings, transcripts, project directories, session tokens, logs with private paths, bundled model files, build output, or credentials.
- Use synthetic transcript fixtures and generic project names in tests, documentation, and screenshots.

## Development setup

Requirements are Python 3.11 or 3.12, Node.js 20.19+ or 22.12+, and FFmpeg.

```powershell
./start.bat
```

On macOS or Linux, use `./start.sh`. The development server is available at `http://127.0.0.1:8000`.

## Checks

Run the relevant checks before requesting review:

```powershell
./.venv/Scripts/python.exe -m pip install -r backend/requirements-dev.txt
./.venv/Scripts/python.exe -m pytest backend/tests -q
npm test --prefix frontend
npm run typecheck --prefix frontend
npm run build --prefix frontend
```

For desktop or installer changes, also run the packaging validation paths documented in `scripts/` and test upgrades against a disposable installation. Do not use a real project data directory as a test target.

On macOS, replace the Python path above with `.venv/bin/python`. The CI backend
suite runs on both Linux and macOS. To validate a native Mac package including
the bundled offline model and media runtime, follow the macOS build instructions
in [README.md](README.md#build-from-source-on-macos) and pass `--smoke-test`.

## Product and accessibility expectations

- Preserve transcript editing by pointer and keyboard.
- Give every custom menu or dialog an accessible name, predictable focus, Escape behavior, and a visible focus indicator.
- Keep destructive changes previewable, reversible, or explicitly confirmed.
- Treat a user's source recording and writable project data as immutable unless a documented action intentionally replaces them.
- Respect reduced-motion, zoom, narrow window, and high-contrast use.
- Avoid external runtime dependencies for the GitHub Pages site.

## Pull requests

Describe the user-visible outcome, affected files, data or lifecycle risks, and the checks you ran. Include public-safe screenshots for visual changes when they add review value. Do not attach a screenshot that exposes a user's project name, transcript, audio filename, local path, or logs.

Security vulnerabilities should follow [SECURITY.md](SECURITY.md), not a public issue.
