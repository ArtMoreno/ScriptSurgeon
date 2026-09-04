#!/usr/bin/env python3
"""Exercise the local speech-to-retake path with generic, offline-only audio.

The caller must provide a new or empty absolute ``--output-dir``.  The probe
creates a generic SAPI WAV there, transcribes it using the local
``backend.transcribe`` runtime, and asks the frontend retake detector for a
review-only alternate-take group.  It never discovers, reads, or modifies a
ScriptSurgeon project or configured data root.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


GENERIC_PHRASE = "We need the blue version. Sorry. We need the blue version with the label."


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        required=True,
        help="New or empty absolute directory for generic test artifacts only.",
    )
    return parser.parse_args()


def resolved(path: Path) -> Path:
    return path.expanduser().resolve(strict=False)


def require_empty_output_dir(raw_value: str) -> Path:
    candidate = Path(raw_value).expanduser()
    if not candidate.is_absolute():
        raise SystemExit("--output-dir must be an absolute path")
    if candidate.exists() and candidate.is_symlink():
        raise SystemExit("--output-dir must not be a symlink")

    output = resolved(candidate)
    repository = resolved(Path(__file__).parent.parent)
    configured_data = os.environ.get("SCRIPTCUT_DATA_DIR")
    forbidden = {
        resolved(Path(output.anchor)),
        resolved(Path.home()),
        repository,
        resolved(repository / "Data"),
        resolved(repository / "projects"),
    }
    if configured_data:
        forbidden.add(resolved(Path(configured_data)))
    if output in forbidden:
        raise SystemExit("refusing an unsafe output directory")
    if output.name.casefold() == "data":
        raise SystemExit("--output-dir must not be named Data")

    if output.exists():
        if not output.is_dir() or output.is_symlink():
            raise SystemExit("--output-dir must name a real directory")
        if any(output.iterdir()):
            raise SystemExit("--output-dir must be new or empty")
    else:
        output.mkdir(parents=True)
    return output


def write_json(path: Path, value: Any) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as output:
        json.dump(value, output, ensure_ascii=False, indent=2, sort_keys=True)
        output.write("\n")


def synthesize_generic_speech(destination: Path) -> None:
    if os.name != "nt":
        raise SystemExit("This integration probe requires Windows SAPI.")
    command = r"""
$ErrorActionPreference = 'Stop'
$voice = New-Object -ComObject SAPI.SpVoice
$stream = New-Object -ComObject SAPI.SpFileStream
try {
  $stream.Open($env:SCRIPTSURGEON_GENERIC_RETAKE_AUDIO, 3, $false)
  $voice.AudioOutputStream = $stream
  [void]$voice.Speak($env:SCRIPTSURGEON_GENERIC_RETAKE_TEXT)
} finally {
  if ($stream) { $stream.Close() }
}
"""
    environment = os.environ.copy()
    environment["SCRIPTSURGEON_GENERIC_RETAKE_AUDIO"] = str(destination)
    environment["SCRIPTSURGEON_GENERIC_RETAKE_TEXT"] = GENERIC_PHRASE
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode or not destination.is_file() or destination.stat().st_size < 44:
        raise RuntimeError(f"Windows SAPI synthesis failed with exit code {result.returncode}")


def check_frontend_retake(repository: Path, words_path: Path, summary_path: Path) -> dict[str, Any]:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required to run the frontend retake check")
    command = r"""
import fs from 'node:fs'
import { runCleanup } from './frontend/src/lib/cleanup.ts'

const words = JSON.parse(fs.readFileSync(process.env.SCRIPTSURGEON_RETAKE_WORDS_PATH, 'utf8'))
const result = runCleanup('retakes', words, [], [])
const group = result.proposals.find((proposal) => proposal.retakeGroup)?.retakeGroup
const summary = {
  transcribedWordCount: words.length,
  retakeProposalCount: result.proposals.length,
  retakeGroupCount: result.proposals.filter((proposal) => Boolean(proposal.retakeGroup)).length,
  candidateCount: group?.candidates.length ?? 0,
  hasReviewableRetake: Boolean(group),
  autoSelectedCount: result.selectedProposalIds.length,
}
fs.writeFileSync(process.env.SCRIPTSURGEON_RETAKE_SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
if (!summary.hasReviewableRetake || summary.candidateCount < 2 || summary.autoSelectedCount !== 0) {
  process.exit(2)
}
"""
    environment = os.environ.copy()
    environment["SCRIPTSURGEON_RETAKE_WORDS_PATH"] = str(words_path)
    environment["SCRIPTSURGEON_RETAKE_SUMMARY_PATH"] = str(summary_path)
    result = subprocess.run(
        [node, "--input-type=module", "--eval", command],
        cwd=repository,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise RuntimeError(f"frontend retake integration check failed with exit code {result.returncode}")
    return json.loads(summary_path.read_text(encoding="utf-8"))


def main() -> None:
    args = parse_args()
    output_dir = require_empty_output_dir(args.output_dir)
    repository = resolved(Path(__file__).parent.parent)
    audio_path = output_dir / "generic-retake.wav"
    words_path = output_dir / "transcribed-words.json"
    summary_path = output_dir / "retake-summary.json"

    synthesize_generic_speech(audio_path)
    sys.path.insert(0, str(repository))
    from backend.transcribe import transcribe_words

    words, duration, sample_rate = transcribe_words(str(audio_path))
    if not words or duration <= 0:
        raise RuntimeError("local transcription returned no timestamped words")
    if not all(
        isinstance(word.get("startTime"), (int, float))
        and isinstance(word.get("endTime"), (int, float))
        and 0 <= word["startTime"] <= word["endTime"] <= duration + 0.01
        for word in words
    ):
        raise RuntimeError("local transcription returned invalid word timing")
    if any(words[index]["startTime"] < words[index - 1]["startTime"] for index in range(1, len(words))):
        raise RuntimeError("local transcription word timestamps are not monotonic")

    write_json(words_path, words)
    retake_summary = check_frontend_retake(repository, words_path, summary_path)
    # Keep console output free of transcript text, source paths, and local
    # project information. The artifacts are generic and exist only under the
    # caller-selected empty directory.
    print(json.dumps({
        "ok": True,
        "audioDurationSeconds": duration,
        "sampleRate": sample_rate,
        **retake_summary,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
