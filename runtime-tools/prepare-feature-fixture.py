#!/usr/bin/env python3
"""Create a deterministic ScriptSurgeon feature-smoke project in a fresh DATA root.

This utility deliberately has no default output. It never imports the backend,
reads SCRIPTCUT_DATA_DIR, or discovers an installed ScriptSurgeon Data directory.
The caller must supply a new or empty absolute directory with --data-root.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import wave
from pathlib import Path
from typing import Any


PROJECT_ID = "fea7acc3e001"
PROJECT_NAME = "Feature Acceptance Fixture"
SAMPLE_RATE = 48_000
SOURCE_DURATION = 6.0
FILLER_WORD_ID = "0000000002"
RETAKE_WORD_IDS = ["0000000003", "0000000004", "0000000005"]
GAP_WORD_IDS = ["0000000005", "0000000009"]
ANCHOR_WORD_ID = "0000000009"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-root",
        required=True,
        help="New or empty absolute temporary SCRIPTCUT_DATA_DIR to populate.",
    )
    return parser.parse_args()


def require_empty_explicit_root(raw_value: str) -> Path:
    raw = Path(raw_value).expanduser()
    if not raw.is_absolute():
        raise SystemExit("--data-root must be an absolute path; no implicit working-directory output is allowed")
    if raw.exists() and raw.is_symlink():
        raise SystemExit("--data-root must not be a symlink")
    root = raw.resolve()
    app_root = Path(__file__).resolve().parent.parent
    forbidden = {
        Path(root.anchor).resolve(),
        Path.home().resolve(),
        app_root,
        (app_root / "Data").resolve(),
        (app_root / "projects").resolve(),
    }
    looks_like_installed_data = (
        root.name.casefold() == "data"
        and any((root.parent / executable).is_file() for executable in ("ScriptSurgeon.exe", "ScriptCut.exe"))
    )
    if root in forbidden or looks_like_installed_data:
        raise SystemExit(f"refusing unsafe DATA root: {root}")
    if root.exists():
        if root.is_symlink() or not root.is_dir():
            raise SystemExit("--data-root must name a real directory, not a file or symlink")
        if any(root.iterdir()):
            raise SystemExit("--data-root must be new or empty so user projects can never be overwritten")
    else:
        root.mkdir(parents=True)
    return root


def write_tone(path: Path, duration: float, frequency: float) -> None:
    frame_count = round(duration * SAMPLE_RATE)
    frames = bytearray(frame_count * 2)
    for index in range(frame_count):
        sample = round(8_000 * math.sin(2 * math.pi * frequency * index / SAMPLE_RATE))
        struct.pack_into("<h", frames, index * 2, sample)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(frames)


def write_json(path: Path, payload: Any) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as output:
        json.dump(payload, output, ensure_ascii=False, indent=2, sort_keys=True)
        output.write("\n")


def word(identifier: int, text: str, start: float, end: float, gap_after: float) -> dict[str, Any]:
    return {
        "id": f"{identifier:010x}",
        "text": text,
        "startTime": start,
        "endTime": end,
        "isFiller": False,
        "isRetake": False,
        "isRemoved": False,
        "gapAfter": gap_after,
    }


def main() -> None:
    args = parse_args()
    data_root = require_empty_explicit_root(args.data_root)
    project_dir = data_root / "projects" / PROJECT_ID
    fixtures_dir = data_root / "feature-fixtures"
    project_dir.mkdir(parents=True)
    fixtures_dir.mkdir()

    source_path = project_dir / "original.wav"
    first_insert = fixtures_dir / "insert-660hz-0.6s.wav"
    second_insert = fixtures_dir / "insert-880hz-0.9s.wav"
    write_tone(source_path, SOURCE_DURATION, 330.0)
    write_tone(first_insert, 0.6, 660.0)
    write_tone(second_insert, 0.9, 880.0)

    words = [
        word(1, "intro", 0.20, 0.45, 0.10),
        word(2, "um", 0.55, 0.70, 0.10),
        word(3, "we", 0.80, 1.00, 0.10),
        word(4, "need", 1.10, 1.35, 0.10),
        word(5, "clarity", 1.45, 1.75, 1.60),
        word(6, "we", 3.35, 3.55, 0.10),
        word(7, "need", 3.65, 3.90, 0.10),
        word(8, "clarity", 4.00, 4.30, 0.10),
        word(9, "finish", 4.40, 4.70, 0.95),
        word(10, "now", 5.65, 5.85, 0.0),
    ]
    state = {
        "words": words,
        "insertClips": [],
        "shortenedGapIds": [],
        "studioSound": False,
        "collapsedRetakes": [],
        "cleanupKeepWordIds": [],
        "cleanupKeepGapIds": [],
        "revision": 1,
    }
    write_json(project_dir / "state.json", state)
    write_json(project_dir / "meta.json", {
        "id": PROJECT_ID,
        "name": PROJECT_NAME,
        "duration": SOURCE_DURATION,
        "sampleRate": SAMPLE_RATE,
        "sourceBytes": source_path.stat().st_size,
    })
    write_json(project_dir / "status.json", {
        "status": "ready",
        "stage": "ready",
        "message": "Ready to edit",
        "progress": 1.0,
        "error": None,
    })

    manifest = {
        "dataRoot": str(data_root),
        "projectId": PROJECT_ID,
        "projectName": PROJECT_NAME,
        "projectPath": str(project_dir),
        "sourcePath": str(source_path),
        "firstInsertPath": str(first_insert),
        "secondInsertPath": str(second_insert),
        "sourceDuration": SOURCE_DURATION,
        "firstInsertDuration": 0.6,
        "secondInsertDuration": 0.9,
        "expectedExportDurationAfterUndo": 6.58,
        "fillerWordId": FILLER_WORD_ID,
        "retakeWordIds": RETAKE_WORD_IDS,
        "gapWordIds": GAP_WORD_IDS,
        "anchorWordId": ANCHOR_WORD_ID,
    }
    manifest_path = data_root / "feature-fixture.json"
    write_json(manifest_path, manifest)
    manifest["manifestPath"] = str(manifest_path)
    print(json.dumps(manifest, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
