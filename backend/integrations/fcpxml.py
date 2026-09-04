"""Final Cut Pro XML: the richer timeline handoff.

Where an EDL carries in and out points against one file, FCPXML carries the
whole project - the original and every inserted take as separate assets, the
cut as a spine of clips, and markers and chapters attached to the clips that
contain them.

Verified by round-tripping through OpenTimelineIO's fcpx_xml adapter, which
reads back the exact cut. That is an independent parser, not an NLE - no
editing application has imported one of these files yet.

Like the EDL this references media rather than copying it, so the handoff stays
instant and the original recording is never touched.

Times are rational strings. Milliseconds are used as the timebase ("800/1000s")
because the edit is computed in milliseconds and that denominator represents it
exactly; converting to an audio or frame timebase would round every boundary.
"""
from __future__ import annotations

from pathlib import Path
from xml.sax.saxutils import quoteattr

from ..timeline import Segment, locate_anchor
from . import ExportRequest, Target, register

FCPXML_VERSION = "1.10"
# Marker duration must be non-zero, and one millisecond reads as a point marker
# in every importer tried.
MARKER_TICK_MS = 1

# A sequence's format must declare frameDuration. Importers read the sequence
# rate from it before they read any clip, so omitting it fails the parse
# outright rather than degrading - even for audio, which has no frames.
DEFAULT_FPS = 30.0
# Broadcast rates are exact ratios, not the decimals they are named after.
_FRAME_DURATIONS = {
    23.976: "1001/24000s",
    29.97: "1001/30000s",
    59.94: "1001/60000s",
}


def frame_duration(fps: float) -> str:
    """The `frameDuration` string for a rate, in Apple's hundredths form."""
    exact = _FRAME_DURATIONS.get(round(fps, 3))
    return exact if exact else f"100/{int(round(fps * 100))}s"


def _time(milliseconds: int) -> str:
    return f"{max(0, int(milliseconds))}/1000s"


def _attributes(pairs: list[tuple[str, str]]) -> str:
    return " ".join(f"{name}={quoteattr(value)}" for name, value in pairs)


class _Assets:
    """Assigns resource ids and remembers which media each clip refers to."""

    def __init__(self, source: Path, source_duration: int) -> None:
        self._entries: list[tuple[str, Path, int]] = []
        self._by_key: dict[str, str] = {}
        self.format_id = "r1"
        self.source_id = self.add("source", source, source_duration)

    def get(self, key: str) -> str | None:
        return self._by_key.get(key)

    def add(self, key: str, path: Path, duration: int) -> str:
        if key in self._by_key:
            return self._by_key[key]
        # r1 is the format, so assets start at r2.
        resource_id = f"r{len(self._entries) + 2}"
        self._by_key[key] = resource_id
        self._entries.append((resource_id, path, duration))
        return resource_id

    def render(self) -> list[str]:
        lines: list[str] = []
        for resource_id, path, duration in self._entries:
            attributes = _attributes([
                ("id", resource_id),
                ("name", path.stem),
                ("start", "0s"),
                ("duration", _time(duration)),
                ("hasAudio", "1"),
                ("audioSources", "1"),
            ])
            lines.append(f"    <asset {attributes}>")
            src = _attributes([("kind", "original-media"), ("src", path.as_uri())])
            lines.append(f"      <media-rep {src}/>")
            lines.append("    </asset>")
        return lines


def _markers_for(
    segment: Segment,
    markers: list[dict],
    timeline,
) -> list[str]:
    """Marker elements belonging inside one clip, on that clip's own clock."""
    lines: list[str] = []
    for marker in markers:
        anchor = marker.get("anchor")
        if not isinstance(anchor, dict):
            continue
        located = locate_anchor(timeline, anchor)
        if located is None or located[0] is not segment:
            continue
        _, offset = located
        # A source clip's marker times sit in the source clock the clip's own
        # `start` uses, so the segment's head offset goes back on.
        start = offset + (segment.source_start if segment.kind == "source" else 0)
        chapter = marker.get("kind") == "chapter"
        element = "chapter-marker" if chapter else "marker"
        attributes = _attributes([
            ("start", _time(start)),
            ("duration", _time(MARKER_TICK_MS)),
            ("value", str(marker.get("title") or "Marker")),
        ])
        lines.append(f"              <{element} {attributes}/>")
    return lines


def export_fcpxml(request: ExportRequest) -> Path:
    timeline = request.timeline
    state = request.state
    name = str(request.meta.get("name", "ScriptSurgeon edit"))
    markers = [marker for marker in state.get("markers", []) if isinstance(marker, dict)]

    assets = _Assets(request.source_path, timeline.source_duration)
    # Inserted takes live beside the project, so each distinct clip becomes its
    # own asset before the spine can refer to it.
    for segment in timeline.segments:
        if segment.kind == "insert" and segment.clip_id:
            clip_path = request.project_dir / "recordings" / f"{segment.clip_id}.wav"
            assets.add(segment.clip_id, clip_path, segment.duration)

    fps = float(request.options.get("fps", DEFAULT_FPS))
    format_attributes = _attributes([
        ("id", assets.format_id),
        ("name", "FFVideoFormatRateUndefined"),
        ("frameDuration", frame_duration(fps)),
    ])

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<!DOCTYPE fcpxml>",
        f'<fcpxml version="{FCPXML_VERSION}">',
        "  <resources>",
        f"    <format {format_attributes}/>",
    ]
    lines.extend(assets.render())
    lines.append("  </resources>")
    lines.append("  <library>")
    lines.append(f"    <event name={quoteattr(name)}>")
    lines.append(f"      <project name={quoteattr(name)}>")
    sequence = _attributes([
        ("format", assets.format_id),
        ("duration", _time(timeline.duration)),
        ("tcStart", "0s"),
        ("tcFormat", "NDF"),
    ])
    lines.append(f"        <sequence {sequence}>")
    lines.append("          <spine>")

    for segment in timeline.segments:
        if segment.kind == "insert":
            ref = assets.get(segment.clip_id) if segment.clip_id else None
            if ref is None:
                continue
            clip_name = f"Insert {segment.insert_id or segment.clip_id}"
            start = 0
        else:
            ref = assets.source_id
            clip_name = request.source_path.stem
            start = segment.source_start
        attributes = _attributes([
            ("ref", ref),
            ("name", clip_name),
            ("offset", _time(segment.edited_start)),
            ("start", _time(start)),
            ("duration", _time(segment.duration)),
        ])
        nested = _markers_for(segment, markers, timeline)
        if nested:
            lines.append(f"            <asset-clip {attributes}>")
            lines.extend(nested)
            lines.append("            </asset-clip>")
        else:
            lines.append(f"            <asset-clip {attributes}/>")

    lines.append("          </spine>")
    lines.append("        </sequence>")
    lines.append("      </project>")
    lines.append("    </event>")
    lines.append("  </library>")
    lines.append("</fcpxml>")
    lines.append("")

    path = request.output_dir / "edit.fcpxml"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


register(Target(
    id="fcpxml",
    label="Timeline (Final Cut XML)",
    summary="A richer handoff than EDL: keeps clip names, markers, and inserted takes.",
    extension="fcpxml",
    media_type="application/xml",
    run=export_fcpxml,
))
