# Third-party notices and release distribution information

ScriptSurgeon source code is licensed under the [MIT License](LICENSE). A
desktop package can include components under different licenses. This file is
an attribution and source-reference record for the components staged by the
current Windows packaging input; it is not legal advice or a complete license
assessment for every possible build configuration.

## FFmpeg Windows runtime

The public Windows release workflow pins Chocolatey's `ffmpeg-full` package at
7.1.1 and stages its `ffmpeg.exe`. The workflow rejects a runtime unless its
version banner is `ffmpeg version 7.1.1-full_build-www.gyan.dev` with
`--enable-gpl --enable-version3`. It is the static **full** Windows build
provided by Gyan's FFmpeg builds project, and is GPLv3 according to that
project's build documentation.

- Source tag for the pinned runtime: [FFmpeg n7.1.1](https://github.com/FFmpeg/FFmpeg/tree/n7.1.1)
- Build information and license status: [Gyan FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/)
- License text: [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html)
- Upstream licensing information: [FFmpeg License and Legal Considerations](https://ffmpeg.org/legal.html)

This FFmpeg binary is not covered by ScriptSurgeon's MIT license. The full
build includes FFmpeg and additional third-party libraries; their exact
composition, notices, and source obligations are tied to the particular Gyan
build being redistributed. Source builds may stage a different FFmpeg runtime;
do not publish one without first updating this notice for that exact binary.

### macOS builds

The release workflow builds the macOS `ffmpeg` executable from the signed
upstream [FFmpeg 9.0.1 source archive](https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz).
[`scripts/build-ffmpeg-macos.sh`](scripts/build-ffmpeg-macos.sh) imports the
[FFmpeg release signing key](https://ffmpeg.org/ffmpeg-devel.asc), verifies the
matching detached signature, and compiles one native executable for each
published architecture.

That standalone command-line build disables GPL and version3 code, automatic
third-party-library detection, and shared-library output. It is intended to
remain under FFmpeg's [LGPL v2.1 or later terms](https://ffmpeg.org/legal.html),
subject to the exact configuration recorded in the release build log. It is a
different binary from the Windows Gyan GPLv3 full build and must not inherit the
Windows license statement above.

The macOS desktop package also contains PyAV through faster-whisper. PyAV is a
[BSD-3-Clause Python binding for FFmpeg libraries](https://github.com/PyAV-Org/PyAV)
whose macOS binary wheel carries its own media-library components. Packaging
validation records `libmp3lame` and `libx264` among those components, and the
renderer uses the available PyAV `libmp3lame` encoder only when the intentionally
minimal CLI cannot encode MP3. The macOS package must therefore be treated as
containing GPL-bearing third-party media components; retain the applicable
upstream notices and source/build references with every redistributed asset.

## Local speech model

The current packaging input stages the
[`Systran/faster-whisper-base`](https://huggingface.co/Systran/faster-whisper-base)
model, a CTranslate2 conversion of `openai/whisper-base`. Its model card marks
the model as [MIT licensed](https://opensource.org/license/mit/).

- Model card, conversion details, and files: [Systran/faster-whisper-base](https://huggingface.co/Systran/faster-whisper-base)
- faster-whisper project license: [MIT license text](https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE)

The model and associated tooling remain subject to their own terms and notices;
they are not transferred to ScriptSurgeon by inclusion in a package.

## Redistributing a packaged build

When publishing an installer or executable that includes the FFmpeg runtime or
speech model, keep this notice and the applicable upstream notices with the
release, make the exact component source/build information available for the
specific binary being shipped, and update these references if the bundled
FFmpeg build or model changes. Do not describe a package containing the Gyan
full FFmpeg build as MIT-only.

The public [Licenses & notices page](docs/notices.html) provides the same
release-facing links. It is an attribution aid, not a substitute for an
independent GPL or other third-party-license compliance review.

Dependency versions are recorded in `backend/requirements.txt`,
`frontend/package-lock.json`, and `scripts/build.ps1`.
