# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller one-folder build for the ScriptSurgeon Windows desktop app."""

import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_all


ROOT = Path(SPECPATH).resolve()
FRONTEND_DIST = ROOT / "frontend" / "dist"
MODEL_DIR = ROOT / "vendor" / "models" / "faster-whisper-base"
FFMPEG_EXE = ROOT / "vendor" / "ffmpeg" / "ffmpeg.exe"
ICON_FILE = ROOT / "assets" / "scriptcut.ico"
BUILD_INFO = Path(os.environ.get("SCRIPTCUT_BUILD_INFO_PATH", ROOT / "build" / "build-info.json"))
LICENSE_FILE = ROOT / "LICENSE"
THIRD_PARTY_NOTICES = ROOT / "THIRD_PARTY_NOTICES.md"

required = [
    FRONTEND_DIST,
    MODEL_DIR / "model.bin",
    FFMPEG_EXE,
    ICON_FILE,
    BUILD_INFO,
    LICENSE_FILE,
    THIRD_PARTY_NOTICES,
]
missing = [str(path) for path in required if not path.exists()]
if missing:
    raise SystemExit(
        "ScriptSurgeon packaging inputs are missing. Run scripts/build.ps1 first:\n  "
        + "\n  ".join(missing)
    )

datas = [
    (str(FRONTEND_DIST), "frontend/dist"),
    (str(MODEL_DIR), "models/faster-whisper-base"),
    (str(ICON_FILE), "assets"),
    (str(BUILD_INFO), "."),
    (str(LICENSE_FILE), "."),
    (str(THIRD_PARTY_NOTICES), "."),
]
binaries = [(str(FFMPEG_EXE), "bin")]
hiddenimports = [
    "backend.main",
    "backend.render",
    "backend.transcribe",
    "uvicorn.logging",
    "uvicorn.lifespan.on",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.h11_impl",
]

for package in (
    "faster_whisper",
    "ctranslate2",
    "av",
    "onnxruntime",
    "tokenizers",
    "webview",
    "pythonnet",
    "clr_loader",
):
    package_datas, package_binaries, package_hiddenimports = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

a = Analysis(
    [str(ROOT / "desktop.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "torch",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "cefpython3",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ScriptSurgeon",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ICON_FILE),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="ScriptSurgeon",
)
