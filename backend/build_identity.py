"""Small, non-invasive build identity for local diagnostics."""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Any


def _resource_root() -> Path:
    configured = os.environ.get("SCRIPTCUT_RESOURCE_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def _build_info_path() -> Path | None:
    """Locate the identity file in both PyInstaller one-folder layouts.

    Some WebView2/PyInstaller combinations expose the install root as the
    resource directory, while others expose its ``_internal`` resource root.
    The build file is intentionally shipped in ``_internal``; checking both
    layouts keeps diagnostics faithful without changing application behavior.
    """

    root = _resource_root()
    executable_root = Path(sys.executable).resolve().parent
    candidates = (
        root / "build-info.json",
        root / "_internal" / "build-info.json",
        executable_root / "build-info.json",
        executable_root / "_internal" / "build-info.json",
    )
    return next((path for path in candidates if path.is_file()), None)


def build_identity() -> dict[str, str]:
    """Return safe diagnostic fields without reading project data."""

    fallback = {
        "version": os.environ.get("SCRIPTCUT_BUILD_VERSION", "development"),
        "commit": os.environ.get("SCRIPTCUT_BUILD_COMMIT", "working-tree"),
        "frontendBuildId": os.environ.get("SCRIPTCUT_FRONTEND_BUILD_ID", "development"),
        "backendBuildId": os.environ.get("SCRIPTCUT_BACKEND_BUILD_ID", "development"),
        "builtUtc": os.environ.get("SCRIPTCUT_BUILD_DATE", "unpackaged"),
    }
    path = _build_info_path()
    if path is None:
        return fallback
    try:
        # PowerShell's UTF-8 output can include a BOM. Accept that form as well
        # as ordinary UTF-8 so packaged diagnostics do not silently fall back.
        parsed: Any = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError):
        return fallback
    if not isinstance(parsed, dict):
        return fallback
    identity = {key: str(parsed.get(key) or fallback[key]) for key in fallback}
    logging.getLogger(__name__).info("Loaded build identity from %s", path)
    return identity
