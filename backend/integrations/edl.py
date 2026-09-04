"""CMX3600 EDL: the cut as a list of in and out points, non-destructively.

An EDL is the oldest and most widely understood way to say "play these pieces
of this file, in this order". It references the original recording rather than
copying it, so someone who wants to finish elsewhere gets ScriptSurgeon's
decisions without inheriting its render.

Verified by round-tripping through OpenTimelineIO's cmx_3600 adapter, which
reads back the exact source ranges. That is an independent parser, not an
NLE - no editing application has imported one of these files yet.

The format is frame-based, so every boundary is quantised to the chosen rate.
That is a real loss of precision against the millisecond edit, and it is the
reason the rendered audio remains the authoritative deliverable.
"""
from __future__ import annotations

from pathlib import Path

from ..timeline import Segment, iter_source_segments
from . import ExportRequest, Target, register

DEFAULT_FPS = 30.0
# Rates where the EDL header must declare drop-frame timecode.
_DROP_FRAME_RATES = {29.97, 59.94}


def timecode(milliseconds: int, fps: float) -> str:
    """Format a millisecond position as SMPTE non-drop timecode."""
    total_frames = int(round(max(0, milliseconds) * fps / 1000.0))
    frames_per_hour = int(round(fps * 3600))
    frames_per_minute = int(round(fps * 60))
    frames_per_second = int(round(fps))
    hours, rest = divmod(total_frames, frames_per_hour)
    minutes, rest = divmod(rest, frames_per_minute)
    seconds, frames = divmod(rest, frames_per_second)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}:{frames:02d}"


def _channel(channels: object, video: bool) -> str:
    """The CMX channel code for this source.

    "AA" means audio channels one and two, so using it for a mono recording
    lays the same signal onto two tracks in the importer. "A" is the honest
    code for mono and is what a parser reproduces as a single track.
    """
    mono = isinstance(channels, int) and not isinstance(channels, bool) and channels == 1
    audio = "A" if mono else "AA"
    return f"{audio}/V" if video else audio


def _event(number: int, channel: str, name: str, segment: Segment, fps: float) -> list[str]:
    return [
        f"{number:03d}  AX       {channel:<6} C        "
        f"{timecode(segment.source_start, fps)} {timecode(segment.source_end, fps)} "
        f"{timecode(segment.edited_start, fps)} {timecode(segment.edited_end, fps)}",
        f"* FROM CLIP NAME: {name}",
    ]


def export_edl(request: ExportRequest) -> Path:
    fps = float(request.options.get("fps", DEFAULT_FPS))
    title = str(request.meta.get("name", "ScriptSurgeon edit"))
    channel = _channel(request.meta.get("channels"), bool(request.options.get("video")))
    source_name = request.source_path.name

    lines = [
        f"TITLE: {title}",
        f"FCM: {'DROP FRAME' if round(fps, 2) in _DROP_FRAME_RATES else 'NON-DROP FRAME'}",
        "",
    ]
    for number, segment in enumerate(iter_source_segments(request.timeline), start=1):
        lines.extend(_event(number, channel, source_name, segment, fps))

    if request.timeline.has_inserts:
        # Inserted takes live in the project, not beside the original, so an
        # EDL cannot reference them. Saying so beats silently dropping audio
        # the user recorded on purpose.
        lines.extend([
            "",
            "* NOTE: this project contains inserted takes, which are not",
            "* represented above. Export the rendered WAV to include them.",
        ])

    lines.append("")
    path = request.output_dir / "edit.edl"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


register(Target(
    id="edl",
    label="Timeline (EDL)",
    summary="The cut as in and out points against your original file, for another editor.",
    extension="edl",
    media_type="text/plain",
    run=export_edl,
))
