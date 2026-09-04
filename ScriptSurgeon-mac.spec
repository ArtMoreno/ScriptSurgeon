# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller macOS application bundle for ScriptSurgeon.

Run this spec only on a native macOS runner. The build script stages a
same-architecture FFmpeg binary, a verified Whisper model snapshot, and a
generated ICNS icon before invoking PyInstaller.
"""

import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_all


ROOT = Path(SPECPATH).resolve()
FRONTEND_DIST = ROOT / "frontend" / "dist"
MODEL_DIR = ROOT / "vendor" / "models" / "faster-whisper-base"
FFMPEG_BINARY = ROOT / "vendor" / "ffmpeg" / "ffmpeg"
ICON_FILE = Path(
    os.environ.get("SCRIPTSURGEON_MAC_ICON_PATH", ROOT / "build" / "macos-assets" / "scriptcut.icns")
).resolve()
BUILD_INFO = Path(os.environ.get("SCRIPTCUT_BUILD_INFO_PATH", ROOT / "build" / "build-info.json"))
LICENSE_FILE = ROOT / "LICENSE"
THIRD_PARTY_NOTICES = ROOT / "THIRD_PARTY_NOTICES.md"
BUILD_VERSION = os.environ.get("SCRIPTCUT_BUILD_VERSION", "0.0.0")
TARGET_ARCH = os.environ.get("SCRIPTSURGEON_MAC_TARGET_ARCH") or None
CODE_SIGN_IDENTITY = os.environ.get("SCRIPTSURGEON_CODESIGN_IDENTITY") or None
ENTITLEMENTS_FILE = os.environ.get("SCRIPTSURGEON_MAC_ENTITLEMENTS") or None

required = [
    FRONTEND_DIST,
    MODEL_DIR / "model.bin",
    FFMPEG_BINARY,
    ICON_FILE,
    BUILD_INFO,
    LICENSE_FILE,
    THIRD_PARTY_NOTICES,
]
missing = [str(path) for path in required if not path.exists()]
if missing:
    raise SystemExit(
        "ScriptSurgeon macOS packaging inputs are missing. Run scripts/build-macos.sh first:\n  "
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
binaries = [(str(FFMPEG_BINARY), "bin")]
hiddenimports = [
    "backend.main",
    "backend.render",
    "backend.transcribe",
    "uvicorn.logging",
    "uvicorn.lifespan.on",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.h11_impl",
    # pywebview picks its backend dynamically. Make Cocoa/WebKit explicit so
    # PyInstaller does not discard it as an unobserved runtime import.
    "webview.platforms.cocoa",
    "objc",
    "Foundation",
    "AppKit",
    "WebKit",
    "Quartz",
    "Security",
    "UniformTypeIdentifiers",
]

for package in (
    "faster_whisper",
    "ctranslate2",
    "av",
    "onnxruntime",
    "tokenizers",
    "webview",
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
        # Windows-only pywebview dependencies must never be selected by a
        # macOS release build.
        "pythonnet",
        "clr_loader",
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
    target_arch=TARGET_ARCH,
    codesign_identity=CODE_SIGN_IDENTITY,
    entitlements_file=ENTITLEMENTS_FILE,
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

app = BUNDLE(
    coll,
    name="ScriptSurgeon.app",
    version=BUILD_VERSION,
    icon=str(ICON_FILE),
    bundle_identifier="com.artmoreno.scriptsurgeon",
    info_plist={
        "CFBundleDisplayName": "ScriptSurgeon",
        "CFBundleName": "ScriptSurgeon",
        "CFBundleShortVersionString": BUILD_VERSION,
        "CFBundleVersion": BUILD_VERSION,
        "NSHighResolutionCapable": True,
        "NSMicrophoneUsageDescription": (
            "ScriptSurgeon uses the microphone only when you choose to record "
            "a new project or an insert."
        ),
    },
)
