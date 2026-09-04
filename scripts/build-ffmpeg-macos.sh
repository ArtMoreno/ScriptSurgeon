#!/usr/bin/env bash
# Build one self-contained FFmpeg executable for the macOS application bundle.
# The release workflow verifies the upstream FFmpeg signature before compiling.
set -euo pipefail

VERSION="${SCRIPTSURGEON_FFMPEG_VERSION:-9.0.1}"
TARGET_ARCH=""
OUTPUT=""

usage() {
  cat <<'EOF'
Usage: bash scripts/build-ffmpeg-macos.sh --arch arm64|x86_64 --output PATH

Builds a native, static FFmpeg command-line executable from the signed FFmpeg
release archive. The configuration disables GPL and version3 code and prevents
auto-detection of third-party libraries so the resulting executable does not
depend on Homebrew libraries existing on the destination Mac. MP3 export has a
tested PyAV fallback because the standalone CLI deliberately omits libmp3lame.
EOF
}

while (($#)); do
  case "$1" in
    --arch)
      TARGET_ARCH="${2:?--arch requires arm64 or x86_64}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:?--output requires a path}"
      shift 2
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

[[ "$(uname -s)" == "Darwin" ]] || {
  echo 'scripts/build-ffmpeg-macos.sh must run on macOS.' >&2
  exit 1
}
[[ -n "$OUTPUT" ]] || {
  echo '--output is required.' >&2
  exit 2
}

HOST_ARCH="$(uname -m)"
[[ "$TARGET_ARCH" == "$HOST_ARCH" ]] || {
  echo "FFmpeg must be compiled natively (host: $HOST_ARCH, requested: $TARGET_ARCH)." >&2
  exit 1
}

case "$TARGET_ARCH" in
  arm64)
    CONFIG_ARCH='aarch64'
    ;;
  x86_64)
    CONFIG_ARCH='x86_64'
    ;;
  *)
    echo "Unsupported macOS target architecture: $TARGET_ARCH" >&2
    exit 2
    ;;
esac

for command in curl gpg gpgv make clang tar lipo; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command '$command' was not found." >&2
    exit 1
  }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK_ROOT="${SCRIPTSURGEON_FFMPEG_BUILD_DIR:-$APP_ROOT/build/ffmpeg-macos-$TARGET_ARCH}"
ARCHIVE="ffmpeg-$VERSION.tar.xz"
SOURCE_URL="https://ffmpeg.org/releases/$ARCHIVE"
SIGNATURE_URL="$SOURCE_URL.asc"
KEY_URL='https://ffmpeg.org/ffmpeg-devel.asc'
OUTPUT="$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$OUTPUT")"

rm -rf "$WORK_ROOT"
mkdir -p "$WORK_ROOT"
echo "==> Downloading signed FFmpeg $VERSION source archive"
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 "$SOURCE_URL" -o "$WORK_ROOT/$ARCHIVE"
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 "$SIGNATURE_URL" -o "$WORK_ROOT/$ARCHIVE.asc"
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 "$KEY_URL" -o "$WORK_ROOT/ffmpeg-devel.asc"
KEYRING="$WORK_ROOT/ffmpeg-release-keyring.gpg"
# gpgv verifies against this isolated release keyring and does not depend on a
# background gpg-agent, which is not available on every hosted macOS image.
gpg --batch --yes --dearmor --output "$KEYRING" "$WORK_ROOT/ffmpeg-devel.asc"
gpgv --keyring "$KEYRING" "$WORK_ROOT/$ARCHIVE.asc" "$WORK_ROOT/$ARCHIVE"

echo "==> Configuring a self-contained LGPL FFmpeg executable"
tar -xf "$WORK_ROOT/$ARCHIVE" -C "$WORK_ROOT"
SOURCE_DIR="$WORK_ROOT/ffmpeg-$VERSION"
PREFIX="$WORK_ROOT/prefix"
pushd "$SOURCE_DIR" >/dev/null
./configure \
  --prefix="$PREFIX" \
  --arch="$CONFIG_ARCH" \
  --cc=clang \
  --disable-shared \
  --enable-static \
  --disable-autodetect \
  --disable-doc \
  --disable-debug \
  --disable-network \
  --disable-ffplay \
  --disable-ffprobe \
  --disable-gpl \
  --disable-version3 \
  --disable-x86asm
make -j"$(sysctl -n hw.logicalcpu)"
make install
popd >/dev/null

mkdir -p "$(dirname "$OUTPUT")"
cp -f "$PREFIX/bin/ffmpeg" "$OUTPUT"
chmod 755 "$OUTPUT"

BUILT_ARCHES="$(lipo -archs "$OUTPUT")"
[[ " $BUILT_ARCHES " == *" $TARGET_ARCH "* ]] || {
  echo "Built FFmpeg does not contain $TARGET_ARCH: $BUILT_ARCHES" >&2
  exit 1
}
if otool -L "$OUTPUT" | grep -E '/(opt/homebrew|usr/local)/' >/dev/null; then
  echo 'Built FFmpeg still depends on a Homebrew library.' >&2
  otool -L "$OUTPUT" >&2
  exit 1
fi
"$OUTPUT" -version
echo "FFmpeg ready: $OUTPUT"
