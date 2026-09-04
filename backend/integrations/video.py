"""Cut the picture the same way as the sound. Scaffold only.

Today a video import is transcribed, edited, and exported as audio - the
picture is dropped on the floor. This closes that: the same kept intervals,
applied to the video stream, muxed against the rendered audio.

Deliberately unimplemented for now. The plan, in the order it should be built:

  1. `has_video(path)` via ffprobe; the target is hidden when it returns False,
     which is what `Target.requires_video` is for.
  2. For each source segment, `ffmpeg -ss/-to -c:v libx264 -an` into the scratch
     directory, then concat-demux the pieces. Stream copy is tempting and wrong:
     cuts land mid-GOP and the joins stutter.
  3. Inserted takes are audio-only, so decide what the picture does under them -
     freeze the last frame is the least surprising default, and it needs to be
     a visible choice in the UI rather than a silent one here.
  4. Mux the concat against the already-rendered WAV so the audio is bit-identical
     to the audio-only export, then `-shortest` guards a rounding mismatch.

Long renders need progress: this cannot be a blocking request handler like the
audio export is. Expect a job id plus a status endpoint, mirroring how
transcription already reports through `status.json`.
"""
from __future__ import annotations

from pathlib import Path

from . import ExportRequest, Target, Unavailable, register

VIDEO_SUFFIXES = (".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi")


def looks_like_video(path: Path) -> bool:
    """A cheap pre-check by extension; ffprobe is the real answer."""
    return path.suffix.lower() in VIDEO_SUFFIXES


def export_video(request: ExportRequest) -> Path:
    if not looks_like_video(request.source_path):
        raise Unavailable("this project was not imported from a video file")
    raise Unavailable("video export is not implemented yet")


register(Target(
    id="video-mp4",
    label="Video (MP4)",
    summary="Your video cut to match the transcript, with the edited audio.",
    extension="mp4",
    media_type="video/mp4",
    run=export_video,
    requires_video=True,
    available=False,
))
