<p align="center">
  <img src="docs/assets/scriptsurgeon-icon-v2-256.png" width="104" height="104" alt="ScriptSurgeon icon">
</p>

<h1 align="center">ScriptSurgeon</h1>

<p align="center">
  <strong>Your audio. Under the knife.</strong><br>
  Edit audio by editing text. Local-first, open source, every feature free.
</p>

<p align="center">
  <a href="https://artmoreno.github.io/ScriptSurgeon/"><strong>Product page</strong></a>
  &nbsp;·&nbsp;
  <a href="#download-the-desktop-app"><strong>Download latest</strong></a>
</p>

<p align="center">
  <a href="https://github.com/ArtMoreno/ScriptSurgeon/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/ArtMoreno/ScriptSurgeon/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="MIT licensed" src="https://img.shields.io/badge/license-MIT-f15e3f?style=flat-square">
  <img alt="Windows installer" src="https://img.shields.io/badge/platform-Windows%20installer-171a1c?style=flat-square">
  <img alt="macOS DMG" src="https://img.shields.io/badge/macOS-DMG-665f58?style=flat-square">
  <img alt="Local processing" src="https://img.shields.io/badge/processing-100%25_local-0f8a6c?style=flat-square">
  <img alt="No account required" src="https://img.shields.io/badge/account-not_required-665f58?style=flat-square">
</p>

<p align="center">
  <a href="https://artmoreno.github.io/ScriptSurgeon/">
    <img src="docs/assets/ss-editor.png" width="1100" alt="The ScriptSurgeon workspace: a document-first transcript with contextual cleanup tools">
  </a>
</p>

## Edit audio by editing text

ScriptSurgeon turns spoken audio into an editable transcript. Remove a word and its matching audio leaves the timeline. Restore it and the sound comes back. Tighten long pauses, review retakes, add a missing line, and export a clean WAV without sending the project to a cloud service.

It is built for people who want the speed of a document editor without giving up control of the actual recording.

## What's new in v2026.09.28

- **Retakes that are actually found:** a balanced detection pass catches restarts longer than five words, sentences restarted after a pause, and takes separated by "sorry, let me redo that". Strict keeps the old rules; the switch is per project.
- **One decision per retake:** take rows with playback, tinted differences, a primary Keep button, take labels in the transcript, and a "Take 2 kept" chip after applying.
- **Reword phrases:** select words and press F2 to rewrite them as one phrase. Timing stays exact, edits are marked, and Revert to original text undoes them.
- **A readable recorder:** round record control, live waveform, zoned level meter with peak hold, and take cards.
- **Vim motions:** optional, off by default, in Settings. h j k l, sentence and paragraph motions, visual selection, d/c/r operators, counts, undo and redo.
- **Rename projects** from the home page, the sidebar, or the editor title.

[Published installers](https://github.com/ArtMoreno/ScriptSurgeon/releases/latest) for this version are built by the release workflow on Windows and macOS.

## One local workflow

| 1. Record | 2. Transcribe | 3. Cut | 4. Restore | 5. Export |
| --- | --- | --- | --- | --- |
| Import media or begin with your microphone. | The bundled speech model runs on your machine. | Edit transcript words and the audio follows. | Bring back words, pauses, retakes, or inserted audio. | Preview the assembled edit and save WAV. |

## Cut the fluff. Keep the story.

Select transcript words or a whole passage, then ripple-cut the matching audio. Correct transcript text without changing sound. Click words to seek, or use the waveform when you need precise timing.

The automatic cleanup tools stay separate so each decision remains understandable:

- **Remove fillers** previews filler words only.
- **Shorten gaps** changes long pauses only.
- **Remove retakes** reviews repeated phrases only.

Nothing changes until you confirm the preview.

<p align="center">
  <img src="docs/assets/ss-review.png" width="980" alt="The cleanup workbench reviewing retakes, with two candidate takes and a recommendation">
</p>

## Nothing is ever really gone

Removed words remain visible and restorable. Retake groups can be brought back. Inserted passages can be removed, restored, edited, or re-recorded. Multi-step undo covers the editing session.

Right-click transcript words, pause markers, retake groups, or inserted passages for focused actions. `Shift+F10` opens the same menus from the keyboard.

## Keyboard first, vim optional

Every transcript action has a key: Backspace ripple-cuts, F2 rewords the focused word or the whole selection, Enter plays from a word, `G` shortens the pause at the playhead, and `Shift+F10` opens the actions menu. Press `?` for the full list.

Turn on **Vim motions** in Settings to move and edit the way you do in an editor: `h` `l` `w` `b` by word, `j` `k` by sentence, `{` `}` by paragraph, `gg` `G` to either end; `v` for a visual selection; `x` cuts a word, `dd` cuts a sentence, `s` and `cc` reword, `rr` restores, `u` and `Ctrl+R` undo and redo. Existing shortcuts keep working and unknown keys pass through.

Projects can be renamed from the home page, the project list, or by double-clicking the title in the editor.

## Add new audio right in place

Start a new project from your microphone, or record a missing passage inside an existing edit. Place the insert at the selected word or current playhead, update its transcript, and re-record it later without losing the edit point.

The recorder shows input level while you capture, so a muted microphone or a gain set too hot is obvious before you commit the take rather than after. Pause and resume without ending the take, pick an input when more than one is connected, and record as many takes as you like: earlier ones stay available to compare and switch between until you save.

<p align="center">
  <img src="docs/assets/ss-recorder.png" width="980" alt="The insert recorder with microphone selection, an input-processing choice, and a level check">
</p>

## Finish somewhere else

Not every edit ends in ScriptSurgeon. Export the cut as an **EDL** or **Final Cut XML** - the standard interchange formats for moving an edit between editors. Both describe your cut as a list of in and out points against your original recording rather than a render, so the handoff is instant and the source stays untouched.

Final Cut XML carries the most: every kept run as its own clip, inserted takes as real clips, and your markers and chapters attached to the clips that contain them.

Both formats are frame-based, so edit points land on the nearest frame of the timeline you import into. The exported WAV or MP3 remains the sample-accurate version of your edit.

## No cloud. No compromises.

| On your device | No accounts | No API keys | You are in control |
| --- | --- | --- | --- |
| Projects, transcription, previews, and exports run locally. | No sign-up or login is required. | Normal use needs no paid service or secret key. | Your project files remain on your computer. |

The desktop shell protects its local API with a new random session token, accepts only trusted loopback hosts, and keeps diagnostic logs on the machine. See [SECURITY.md](SECURITY.md) for the security model and responsible disclosure.

> [!IMPORTANT]
> Download desktop builds only from the [latest GitHub Release](https://github.com/ArtMoreno/ScriptSurgeon/releases/latest). Windows and macOS packages are attached there only after their native build and smoke checks succeed.

## Everything, free

There is no paid tier, no account, and nothing held back. Every capability below
ships in every build, on both platforms.

| | |
| --- | --- |
| Local transcription | Runs on your machine with the bundled model |
| Transcript editing and ripple cuts | Remove a word, the audio follows |
| Filler, gap, and retake cleanup | Reviewed before anything is applied |
| Markers and chapters | Local, with chapter audio and chapter list export |
| Studio Sound and loudness normalize | Tone shaping and an EBU R128 target |
| Background noise cleanup | Three strengths, applied before tone shaping |
| WAV and MP3 export | Full file or a selected range |
| Transcript, SRT, VTT export | Including chapter headings and cues |
| Timeline handoff | EDL and Final Cut XML, against your original file |

## Download the desktop app

### Windows installer

Download the current Windows installer from the [latest GitHub Release](https://github.com/ArtMoreno/ScriptSurgeon/releases/latest). The release page is the source of truth for the installer, its SHA-256 checksum, and supported architecture.

### macOS DMG

The release page includes native Apple Silicon and Intel DMGs when their macOS build and smoke checks pass. The Apple Silicon package requires macOS 14 or later; the Intel package targets macOS 13 or later. The initial DMGs are ad-hoc signed but not notarized with Apple, so macOS may require an explicit approval before opening them. Verify the release checksum and open them only if you trust the release source.

## Build from source on Windows

The packaged desktop app uses Edge WebView2. Once built, it runs without a separate Python or Node.js installation.

```powershell
git clone https://github.com/ArtMoreno/ScriptSurgeon.git
cd ScriptSurgeon
./scripts/build.ps1
./scripts/install.ps1
```

The first build reuses an existing `Systran/faster-whisper-base` snapshot when available. Otherwise, it downloads the public model before packaging. No Hugging Face token or API key is required. Use `-ModelSource <directory>` to choose a specific local snapshot.

Each packaged build includes a SHA-256 payload manifest. Upgrades validate and stage the application, roll back on failure, and leave project data outside the deployable payload.

For an offline rebuild using an existing packaging environment and frontend output:

```powershell
./scripts/build.ps1 -SkipDependencies -SkipFrontend
```

## Build from source on macOS

Use Python 3.11 or 3.12 and Node.js 22.12 or newer. The build selects a
supported Python automatically instead of Apple's older system Python. To
choose an interpreter explicitly, set `SCRIPTSURGEON_PYTHON` to its full path.

Build on the same architecture as the destination Mac (Apple Silicon or Intel):

```bash
cd ScriptSurgeon
bash scripts/build-macos.sh --ffmpeg-source /absolute/path/to/ffmpeg --smoke-test
open dist/ScriptSurgeon.app
```

The FFmpeg executable must include your Mac's architecture. For a distributable,
self-contained FFmpeg built from verified upstream source, install GnuPG and
the Xcode Command Line Tools, then run:

```bash
bash scripts/build-ffmpeg-macos.sh --arch "$(uname -m)" --output "$PWD/vendor/ffmpeg/ffmpeg"
bash scripts/build-macos.sh --smoke-test
```

The first build downloads dependencies and the bundled speech model. Subsequent
builds can use `--skip-dependencies --skip-frontend` to reuse those outputs.
The results are `dist/ScriptSurgeon.app` and an architecture-specific DMG in
`release/`. Drag the app to Applications or launch it directly. Local builds
are ad-hoc signed; public distribution requires your own Apple signing and
notarization setup. Projects and logs live in
`~/Library/Application Support/ScriptSurgeon/`, outside the app bundle.

## Development

Development requires Python 3.11 or 3.12, Node.js 20.19+ or 22.12+, and FFmpeg.

```powershell
./start.bat
```

For macOS or Linux development:

```bash
./start.sh
```

Then open `http://127.0.0.1:8000`.

The development model defaults to `base`. Set `MODEL_SIZE` to `tiny`, `small`, `medium`, or `large-v3` before launch to use another public model.

## Repository map

| Path | Purpose |
| --- | --- |
| `frontend/` | React, TypeScript, Zustand, and WaveSurfer transcript editor |
| `backend/` | FastAPI project storage, transcription, rendering, and export |
| `desktop.py` | Native Windows WebView2 / macOS Cocoa-WebKit shell and local process lifecycle |
| `scripts/` | Packaging, icon generation, payload verification, and installation |
| `docs/` | Dependency-free GitHub Pages product site |

## Verification

```powershell
./.venv/Scripts/python.exe -m pip install -r backend/requirements-dev.txt
./.venv/Scripts/python.exe -m pytest backend/tests -q
npm test --prefix frontend
npm run typecheck --prefix frontend
npm run build --prefix frontend
```

The static product page can be served directly from `docs/` with any local web server.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), then open an issue for a bug or product idea. Keep fixtures, screenshots, logs, and diagnostics free of private recordings, real project names, credentials, tokens, and identifying local paths.

## License

ScriptSurgeon is available under the [MIT License](LICENSE). Third-party licenses are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
