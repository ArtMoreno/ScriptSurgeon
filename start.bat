@echo off
REM ScriptSurgeon - local development startup (Windows)
cd /d "%~dp0"

where python >nul 2>nul || (echo Python 3.10+ required: https://www.python.org/downloads/ & exit /b 1)
where node >nul 2>nul || (echo Node.js 18+ required: https://nodejs.org/ & exit /b 1)
REM SCRIPTCUT_FFMPEG points the backend at a specific binary, so accept it in
REM place of one on PATH rather than refusing to start.
if defined SCRIPTCUT_FFMPEG (
  if not exist "%SCRIPTCUT_FFMPEG%" (echo SCRIPTCUT_FFMPEG is set but that file does not exist: %SCRIPTCUT_FFMPEG% & exit /b 1)
) else (
  where ffmpeg >nul 2>nul || (echo FFmpeg required on PATH, or set SCRIPTCUT_FFMPEG to its full path: https://ffmpeg.org/download.html & exit /b 1)
)

if not exist ".venv" (
  echo ==^> Creating Python virtual environment
  python -m venv .venv
)
call .venv\Scripts\activate.bat

echo ==^> Installing Python dependencies
pip install -q --upgrade pip
pip install -q -r backend\requirements.txt

if not exist "frontend\node_modules" (
  echo ==^> Installing frontend dependencies
  cd frontend && call npm ci && cd ..
)

if not exist "frontend\dist" (
  echo ==^> Building frontend
  cd frontend && call npm run build && cd ..
)

if "%MODEL_SIZE%"=="" set MODEL_SIZE=base
REM Prefer a model snapshot already vendored by a previous build. Without this
REM the backend resolves the bare size name and downloads the model on first use.
if not defined SCRIPTCUT_MODEL_PATH (
  if exist "vendor\models\faster-whisper-%MODEL_SIZE%\model.bin" (
    set "SCRIPTCUT_MODEL_PATH=%CD%\vendor\models\faster-whisper-%MODEL_SIZE%"
    echo ==^> Using the vendored %MODEL_SIZE% model
  )
)
echo.
echo ==^> ScriptSurgeon is starting at http://127.0.0.1:8000
.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
