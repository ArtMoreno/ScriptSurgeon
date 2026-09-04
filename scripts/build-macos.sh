#!/usr/bin/env bash
# Build a native macOS ScriptSurgeon.app bundle. This script must run on macOS;
# PyInstaller cannot produce a trustworthy macOS bundle from Windows.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MODEL_SOURCE=""
FFMPEG_SOURCE=""
VERSION=""
TARGET_ARCH=""
SKIP_DEPENDENCIES=false
SKIP_FRONTEND=false
SMOKE_TEST=false

usage() {
  cat <<'EOF'
Usage: bash scripts/build-macos.sh [options]

Options:
  --version VERSION       Build version (default: current UTC timestamp).
  --arch ARCH             Native target architecture: arm64 or x86_64.
  --model-source PATH     Existing faster-whisper-base snapshot to stage.
  --ffmpeg-source PATH    Exact macOS ffmpeg executable to stage.
  --skip-dependencies     Reuse build/macos-packaging-venv.
  --skip-frontend         Reuse frontend/dist.
  --smoke-test            Run the packaged no-window smoke test after build.
  -h, --help              Show this help.

The script intentionally produces one native architecture at a time. Build
arm64 on an Apple Silicon runner and x86_64 on an Intel runner; do not claim a
universal2 release until every bundled native dependency has been verified as
universal2 and the final bundle has been code-signed and notarized.
EOF
}

while (($#)); do
  case "$1" in
    --model-source)
      MODEL_SOURCE="${2:?--model-source requires a path}"
      shift 2
      ;;
    --ffmpeg-source)
      FFMPEG_SOURCE="${2:?--ffmpeg-source requires a path}"
      shift 2
      ;;
    --version)
      VERSION="${2:?--version requires a value}"
      shift 2
      ;;
    --arch)
      TARGET_ARCH="${2:?--arch requires arm64 or x86_64}"
      shift 2
      ;;
    --skip-dependencies)
      SKIP_DEPENDENCIES=true
      shift
      ;;
    --skip-frontend)
      SKIP_FRONTEND=true
      shift
      ;;
    --smoke-test)
      SMOKE_TEST=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "scripts/build-macos.sh must run on macOS." >&2
  exit 1
fi

HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  arm64|x86_64) ;;
  *)
    echo "Unsupported macOS host architecture: $HOST_ARCH" >&2
    exit 1
    ;;
esac

if [[ -z "$TARGET_ARCH" ]]; then
  TARGET_ARCH="$HOST_ARCH"
fi
if [[ "$TARGET_ARCH" != "$HOST_ARCH" ]]; then
  echo "This build must use native dependencies: host is $HOST_ARCH, requested $TARGET_ARCH." >&2
  exit 1
fi

if [[ -z "$VERSION" ]]; then
  VERSION="$(date -u +'%Y.%m.%d.%H%M%S')"
fi
if [[ ! "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$ ]]; then
  echo "Version must be 1-64 characters and contain only letters, numbers, dot, underscore, plus, or hyphen." >&2
  exit 1
fi

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command '$command_name' was not found." >&2
    exit 1
  }
}

copy_directory_contents() {
  local source="$1"
  local destination="$2"
  [[ -d "$source" ]] || { echo "Directory not found: $source" >&2; exit 1; }
  mkdir -p "$destination"
  cp -R "$source"/. "$destination"/
}

BUILD_ROOT="$APP_ROOT/build"
BUILD_VENV="$BUILD_ROOT/macos-packaging-venv"
BUILD_PYTHON="$BUILD_VENV/bin/python"
PYINSTALLER="$BUILD_VENV/bin/pyinstaller"
MODEL_STAGE="$APP_ROOT/vendor/models/faster-whisper-base"
FFMPEG_STAGE="$APP_ROOT/vendor/ffmpeg/ffmpeg"
ICON_STAGE="$BUILD_ROOT/macos-assets/scriptcut.icns"
BUILD_INFO="$BUILD_ROOT/build-info.json"
MODEL_REVISION="${SCRIPTSURGEON_MODEL_REVISION:-a80717a3a48b1b28aa687bca146cb7301feae1b1}"
export SCRIPTSURGEON_MODEL_REVISION="$MODEL_REVISION"

cd "$APP_ROOT"
COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || printf 'unknown')"
BUILT_UTC="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
export VITE_SCRIPTSURGEON_BUILD_VERSION="$VERSION"
export VITE_SCRIPTSURGEON_BUILD_COMMIT="$COMMIT"
export SCRIPTCUT_BUILD_VERSION="$VERSION"
export SCRIPTCUT_BUILD_COMMIT="$COMMIT"
export SCRIPTCUT_BUILD_DATE="$BUILT_UTC"
export SCRIPTCUT_BUILD_INFO_PATH="$BUILD_INFO"
export SCRIPTSURGEON_MAC_TARGET_ARCH="$TARGET_ARCH"
export SCRIPTSURGEON_MAC_ICON_PATH="$ICON_STAGE"

if [[ "$SKIP_DEPENDENCIES" == false ]]; then
  require_command python3
  if [[ ! -x "$BUILD_PYTHON" ]]; then
    echo "==> Creating isolated macOS packaging environment"
    python3 -m venv "$BUILD_VENV"
  fi
  echo "==> Installing pinned build and runtime dependencies"
  "$BUILD_PYTHON" -m pip install --upgrade pip
  "$BUILD_PYTHON" -m pip install \
    -r "$APP_ROOT/backend/requirements.txt" \
    'pywebview==6.2.1' \
    'pyinstaller==6.21.0' \
    'pillow==12.3.0'
else
  [[ -x "$BUILD_PYTHON" && -x "$PYINSTALLER" ]] || {
    echo "--skip-dependencies requires $BUILD_VENV." >&2
    exit 1
  }
fi

"$BUILD_PYTHON" -c "import PIL; assert PIL.__version__ == '12.3.0', PIL.__version__"

if [[ "$SKIP_FRONTEND" == false ]]; then
  require_command npm
  if [[ -f "$APP_ROOT/frontend/package-lock.json" ]]; then
    echo "==> Installing locked frontend dependencies"
    npm ci --prefix "$APP_ROOT/frontend"
  else
    echo "==> Installing frontend dependencies"
    npm install --prefix "$APP_ROOT/frontend"
  fi
  echo "==> Building frontend"
  npm run build --prefix "$APP_ROOT/frontend"
fi

FRONTEND_ASSET="$(find "$APP_ROOT/frontend/dist/assets" -maxdepth 1 -type f -name 'index-*.js' -print 2>/dev/null | LC_ALL=C sort | head -n 1 || true)"
if [[ -n "$FRONTEND_ASSET" ]]; then
  FRONTEND_BUILD_ID="$(shasum -a 256 "$FRONTEND_ASSET" | awk '{print substr($1, 1, 12)}')"
else
  FRONTEND_BUILD_ID="unknown"
fi
mkdir -p "$BUILD_ROOT"
export SCRIPTCUT_FRONTEND_BUILD_ID="$FRONTEND_BUILD_ID"
"$BUILD_PYTHON" - "$BUILD_INFO" <<'PY'
import json
import os
import sys

path = sys.argv[1]
payload = {
    "version": os.environ["SCRIPTCUT_BUILD_VERSION"],
    "commit": os.environ["SCRIPTCUT_BUILD_COMMIT"],
    "frontendBuildId": os.environ["SCRIPTCUT_FRONTEND_BUILD_ID"],
    "backendBuildId": os.environ["SCRIPTCUT_BUILD_COMMIT"],
    "builtUtc": os.environ["SCRIPTCUT_BUILD_DATE"],
}
with open(path, "w", encoding="utf-8") as output:
    json.dump(payload, output, indent=2)
    output.write("\n")
PY

if [[ ! -f "$MODEL_STAGE/model.bin" ]]; then
  if [[ -n "$MODEL_SOURCE" ]]; then
    echo "==> Staging local faster-whisper model from $MODEL_SOURCE"
    copy_directory_contents "$MODEL_SOURCE" "$MODEL_STAGE"
  else
    echo "==> Downloading pinned faster-whisper-base model revision $MODEL_REVISION"
    export SCRIPTSURGEON_MODEL_STAGE="$MODEL_STAGE"
    "$BUILD_PYTHON" - <<'PY'
import os
from huggingface_hub import snapshot_download

snapshot_download(
    "Systran/faster-whisper-base",
    revision=os.environ["SCRIPTSURGEON_MODEL_REVISION"],
    local_dir=os.environ["SCRIPTSURGEON_MODEL_STAGE"],
)
PY
  fi
fi

for model_file in config.json model.bin tokenizer.json vocabulary.txt; do
  [[ -f "$MODEL_STAGE/$model_file" ]] || {
    echo "The staged model is incomplete; missing $MODEL_STAGE/$model_file" >&2
    exit 1
  }
done

if [[ ! -f "$FFMPEG_STAGE" ]]; then
  if [[ -z "$FFMPEG_SOURCE" ]]; then
    FFMPEG_SOURCE="${SCRIPTSURGEON_FFMPEG_SOURCE:-}"
  fi
  if [[ -z "$FFMPEG_SOURCE" ]]; then
    FFMPEG_SOURCE="$(command -v ffmpeg || true)"
  fi
  [[ -n "$FFMPEG_SOURCE" && -f "$FFMPEG_SOURCE" ]] || {
    echo "FFmpeg was not found. Install a reviewed macOS FFmpeg build or pass --ffmpeg-source." >&2
    exit 1
  }
  echo "==> Staging FFmpeg from $FFMPEG_SOURCE"
  mkdir -p "$(dirname "$FFMPEG_STAGE")"
  cp -f "$FFMPEG_SOURCE" "$FFMPEG_STAGE"
  chmod 755 "$FFMPEG_STAGE"
fi
[[ -x "$FFMPEG_STAGE" ]] || { echo "Bundled FFmpeg is not executable: $FFMPEG_STAGE" >&2; exit 1; }
require_command lipo
FFMPEG_ARCHES="$(lipo -archs "$FFMPEG_STAGE" 2>/dev/null || true)"
[[ " $FFMPEG_ARCHES " == *" $TARGET_ARCH "* ]] || {
  echo "Bundled FFmpeg does not contain the requested $TARGET_ARCH architecture: $FFMPEG_STAGE" >&2
  exit 1
}

require_command sips
require_command iconutil
ICONSET_PARENT="$(mktemp -d "$BUILD_ROOT/scriptsurgeon-icon.XXXXXX")"
ICONSET_DIR="$ICONSET_PARENT/ScriptSurgeon.iconset"
cleanup_iconset() {
  rm -rf "$ICONSET_PARENT"
}
trap cleanup_iconset EXIT
mkdir -p "$ICONSET_DIR"
mkdir -p "$BUILD_ROOT/macos-assets"
MASTER_ICON="$APP_ROOT/assets/scriptcut-icon-master.png"
[[ -f "$MASTER_ICON" ]] || { echo "Icon master is missing: $MASTER_ICON" >&2; exit 1; }
for definition in \
  '16:icon_16x16.png' \
  '32:icon_16x16@2x.png' \
  '32:icon_32x32.png' \
  '64:icon_32x32@2x.png' \
  '128:icon_128x128.png' \
  '256:icon_128x128@2x.png' \
  '256:icon_256x256.png' \
  '512:icon_256x256@2x.png' \
  '512:icon_512x512.png' \
  '1024:icon_512x512@2x.png'; do
  size="${definition%%:*}"
  filename="${definition#*:}"
  sips -z "$size" "$size" "$MASTER_ICON" --out "$ICONSET_DIR/$filename" >/dev/null
done
iconutil -c icns "$ICONSET_DIR" -o "$ICON_STAGE"
[[ -f "$ICON_STAGE" ]] || { echo "ICNS generation failed: $ICON_STAGE" >&2; exit 1; }

echo "==> Building the macOS application bundle for $TARGET_ARCH"
"$PYINSTALLER" --noconfirm --clean "$APP_ROOT/ScriptSurgeon-mac.spec"

APP_BUNDLE="$APP_ROOT/dist/ScriptSurgeon.app"
APP_EXECUTABLE="$APP_BUNDLE/Contents/MacOS/ScriptSurgeon"
[[ -x "$APP_EXECUTABLE" ]] || {
  echo "Build completed without the expected app executable: $APP_EXECUTABLE" >&2
  exit 1
}
APP_ARCHES="$(lipo -archs "$APP_EXECUTABLE" 2>/dev/null || true)"
[[ " $APP_ARCHES " == *" $TARGET_ARCH "* ]] || {
  echo "Built app does not contain the requested $TARGET_ARCH architecture: $APP_EXECUTABLE" >&2
  exit 1
}

if [[ "$SMOKE_TEST" == true ]]; then
  SMOKE_DATA="$(mktemp -d "$BUILD_ROOT/scriptsurgeon-smoke.XXXXXX")"
  trap 'rm -rf "$ICONSET_PARENT" "$SMOKE_DATA"' EXIT
  echo "==> Running packaged smoke test"
  SCRIPTCUT_DATA_DIR="$SMOKE_DATA" "$APP_EXECUTABLE" --smoke-test
  echo "==> Verifying MP3 export availability"
  SCRIPTCUT_FFMPEG="$FFMPEG_STAGE" "$BUILD_PYTHON" - "$BUILD_ROOT" <<'PY'
import tempfile
import wave
from pathlib import Path

from backend.render import encode_mp3

with tempfile.TemporaryDirectory(dir=Path(__import__("sys").argv[1])) as directory:
    source = Path(directory) / "smoke.wav"
    output = Path(directory) / "smoke.mp3"
    with wave.open(str(source), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(44_100)
        wav.writeframes(b"\x00\x00" * 4_410)
    encode_mp3(str(source), str(output))
    if not output.is_file() or output.stat().st_size <= 0:
        raise RuntimeError("macOS MP3 export smoke check did not produce audio")
PY
fi

require_command codesign
SIGNING_IDENTITY="${SCRIPTSURGEON_CODESIGN_IDENTITY:--}"
if [[ "$SIGNING_IDENTITY" == "-" ]]; then
  echo "==> Ad-hoc signing macOS app bundle"
  codesign --force --deep --sign - "$APP_BUNDLE"
else
  echo "==> Signing macOS app bundle with $SIGNING_IDENTITY"
  codesign --force --deep --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$APP_BUNDLE"
fi
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

require_command hdiutil
ASSET_ARCH="$TARGET_ARCH"
if [[ "$ASSET_ARCH" == "x86_64" ]]; then
  ASSET_ARCH="x64"
fi
RELEASE_DIR="$APP_ROOT/release"
DMG_PATH="$RELEASE_DIR/ScriptSurgeon-$VERSION-macos-$ASSET_ARCH.dmg"
mkdir -p "$RELEASE_DIR"
rm -f "$DMG_PATH"
echo "==> Creating macOS disk image"
hdiutil create -volname "ScriptSurgeon" -srcfolder "$APP_BUNDLE" -ov -format UDZO "$DMG_PATH" >/dev/null
if [[ "$SIGNING_IDENTITY" == "-" ]]; then
  codesign --force --sign - "$DMG_PATH"
else
  codesign --force --timestamp --sign "$SIGNING_IDENTITY" "$DMG_PATH"
fi
hdiutil verify "$DMG_PATH" >/dev/null

echo "Build ready: $APP_BUNDLE"
echo "Architecture: $TARGET_ARCH"
echo "Release archive: $DMG_PATH"
echo "Before public distribution, notarize the final archive and publish its checksum and third-party source notices."
