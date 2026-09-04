#!/usr/bin/env bash
# ScriptSurgeon - local development startup (macOS / Linux)
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Checking prerequisites"
command -v python3 >/dev/null || { echo "Python 3.11 or 3.12 is required"; exit 1; }
command -v node >/dev/null || { echo "Node.js 18+ is required"; exit 1; }
# SCRIPTCUT_FFMPEG points the backend at a specific binary, so accept it in place
# of one on PATH rather than refusing to start.
if [ -n "${SCRIPTCUT_FFMPEG:-}" ]; then
  [ -x "$SCRIPTCUT_FFMPEG" ] || { echo "SCRIPTCUT_FFMPEG is set but not executable: $SCRIPTCUT_FFMPEG"; exit 1; }
else
  command -v ffmpeg >/dev/null || {
    echo "FFmpeg is required (brew install ffmpeg / sudo apt install ffmpeg),"
    echo "or set SCRIPTCUT_FFMPEG to the full path of an ffmpeg binary."
    exit 1
  }
fi

if [ ! -d ".venv" ]; then
  echo "==> Creating Python virtual environment"
  python3 -m venv .venv
fi

echo "==> Installing Python dependencies"
.venv/bin/python -m pip install -q -r backend/requirements.txt

if [ ! -d "frontend/node_modules" ]; then
  echo "==> Installing locked frontend dependencies"
  (cd frontend && npm ci --silent)
fi

if [ ! -d "frontend/dist" ] || [ "frontend/src" -nt "frontend/dist" ]; then
  echo "==> Building frontend"
  (cd frontend && npm run build)
fi

export MODEL_SIZE="${MODEL_SIZE:-base}"
# Prefer a model snapshot already vendored by a previous build. Without this the
# backend resolves the bare size name and downloads the model on first use.
if [ -z "${SCRIPTCUT_MODEL_PATH:-}" ] && [ -f "vendor/models/faster-whisper-$MODEL_SIZE/model.bin" ]; then
  export SCRIPTCUT_MODEL_PATH="$PWD/vendor/models/faster-whisper-$MODEL_SIZE"
  echo "==> Using the vendored $MODEL_SIZE model"
fi
echo ""
echo "==> ScriptSurgeon is starting at http://127.0.0.1:8000"
echo ""
exec .venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
