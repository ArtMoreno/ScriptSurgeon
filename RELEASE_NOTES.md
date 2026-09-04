# September workspace update (source)

Document-first editor, searchable home, reviewed retake improvements, live recorder feedback and take downloads, exact WAV range exports, and refreshed Windows icon. Current source changes; a new public installer release has not been published with this commit. Full recorder crash recovery remains pending.

# ScriptSurgeon desktop release

**ScriptSurgeon is now completely free and open source.** The previous Pro tier has
been removed: MP3 export, background noise cleanup, loudness normalize, chapter audio
and chapter list export, transcript with headings, VTT with chapter cues, and timeline
handoff (EDL and Final Cut XML) are included in every build. There is no license key,
no account, and nothing to buy. If you purchased a Pro key, it is no longer needed and
nothing verifies it. For release questions, use the repository issue tracker.

This release ships the local desktop editor as:

- a Windows x64 installer;
- macOS x64 and Apple Silicon DMGs; and
- `SHA256SUMS.txt` for every published package.

The initial macOS DMGs are ad-hoc signed but are not notarized with Apple. macOS
may require an explicit approval before opening them. The Apple Silicon build
requires macOS 14 or later. Download only from this release page, verify the
matching SHA-256 value, and keep project media backed up before installing any
new desktop build.

Projects, transcription, previews, and exports stay on the device. See
[`THIRD_PARTY_NOTICES.md`](https://github.com/ArtMoreno/ScriptSurgeon/blob/main/THIRD_PARTY_NOTICES.md)
for bundled-runtime notices and source links.
