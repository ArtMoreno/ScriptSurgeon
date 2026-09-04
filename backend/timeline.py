"""The edit as data: where every retained source moment lands after the cut.

The renderer already knows this implicitly - it splices audio and throws the
mapping away. Everything a delivery integration needs (captions that line up,
an EDL an NLE can open, a video stream cut like the audio) is that same mapping
expressed as numbers instead of samples, so it lives here once and the
integrations stay thin.

Times are milliseconds. "Source" is the original recording's clock; "edited" is
the exported file's clock.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Iterable

from .render import CROSSFADE_MS, kept_intervals

# A junction is not a butt splice: the renderer crossfades, which pulls
# everything after it earlier by the crossfade length. Ignoring this drifts
# captions by about 10 ms per cut, inaudible on one edit and over a second
# across a heavily tightened hour.
_JUNCTION_MS = CROSSFADE_MS


@dataclass(frozen=True)
class Segment:
    """One continuous run of audio in the exported file."""

    kind: str  # "source" or "insert"
    edited_start: int
    edited_end: int
    # Source-clock bounds for kind == "source"; both 0 for an insert, which has
    # no position on the original recording.
    source_start: int = 0
    source_end: int = 0
    clip_id: str | None = None
    # The insert entry's own id, which is what markers anchor to. Distinct from
    # clip_id: several inserts can reuse one recorded clip.
    insert_id: str | None = None

    @property
    def duration(self) -> int:
        return self.edited_end - self.edited_start


@dataclass(frozen=True)
class Cue:
    """A caption line on the edited clock."""

    index: int
    start: int
    end: int
    text: str
    speaker: str | None = None


class EditTimeline:
    """The source-to-edited mapping for one project state."""

    def __init__(self, segments: list[Segment], source_duration: int) -> None:
        self.segments = segments
        self.source_duration = source_duration

    @property
    def duration(self) -> int:
        return self.segments[-1].edited_end if self.segments else 0

    @property
    def has_inserts(self) -> bool:
        return any(segment.kind == "insert" for segment in self.segments)

    def to_edited(self, source_ms: float) -> int | None:
        """Map a source timestamp onto the export, or None when it was cut.

        A time inside a removed region has no honest edited position, so
        callers drop it rather than pin it to the splice; a caption anchored to
        a cut word would sit on top of its neighbour.
        """
        target = round(source_ms)
        for segment in self.segments:
            if segment.kind != "source":
                continue
            if segment.source_start <= target <= segment.source_end:
                return segment.edited_start + (target - segment.source_start)
        return None


def build_timeline(
    words: list[dict],
    gap_edits: list[dict] | list[str],
    source_duration_ms: int,
    insert_clips: list[dict] | None = None,
    clip_duration: Callable[[str], int] | None = None,
) -> EditTimeline:
    """Compose the timeline the renderer would produce for this state.

    `clip_duration` resolves an inserted take's length in milliseconds. It is
    injected so this module never touches the filesystem and stays testable;
    without it, inserts are skipped rather than guessed at.
    """
    intervals = kept_intervals(words, gap_edits, source_duration_ms)
    events = _insert_events(insert_clips or [], intervals, source_duration_ms)

    ordered: list[tuple[str, int, int, str | None, str | None]] = []
    remaining = [[start, end] for start, end in intervals]
    index = 0
    for source_ms, _, clip_id, insert_id in events:
        while index < len(remaining):
            start, end = remaining[index]
            if end <= source_ms:
                if end > start:
                    ordered.append(("source", start, end, None, None))
                index += 1
                continue
            if start < source_ms:
                ordered.append(("source", start, source_ms, None, None))
                remaining[index][0] = source_ms
            break
        length = clip_duration(clip_id) if clip_duration and clip_id else 0
        if length > 0:
            ordered.append(("insert", 0, length, clip_id, insert_id))
    while index < len(remaining):
        start, end = remaining[index]
        if end > start:
            ordered.append(("source", start, end, None, None))
        index += 1

    segments: list[Segment] = []
    cursor = 0
    previous_length = 0
    for kind, start, end, clip_id, insert_id in ordered:
        length = end - start
        if length <= 0:
            continue
        if segments:
            cursor -= min(_JUNCTION_MS, previous_length, length)
        segments.append(
            Segment(
                kind=kind,
                edited_start=cursor,
                edited_end=cursor + length,
                source_start=start if kind == "source" else 0,
                source_end=end if kind == "source" else 0,
                clip_id=clip_id,
                insert_id=insert_id,
            )
        )
        cursor += length
        previous_length = length
    return EditTimeline(segments, source_duration_ms)


def _insert_events(
    insert_clips: list[dict],
    intervals: list[tuple[int, int]],
    source_duration_ms: int,
) -> list[tuple[int, int, str | None, str | None]]:
    """Active inserts as (source position, declared order, clip id, insert id).

    Order is part of the sort key because several takes can be dropped at the
    same boundary and their relative order is the user's stated intent.
    """
    events: list[tuple[int, int, str | None, str | None]] = []
    for order, item in enumerate(insert_clips):
        if item.get("isRemoved", False):
            continue
        try:
            seconds = float(item.get("sourceTime"))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(seconds):
            continue
        position = max(0, min(source_duration_ms, round(seconds * 1000)))
        events.append((
            _snap_to_kept(position, intervals),
            order,
            item.get("clipId"),
            item.get("id"),
        ))
    events.sort(key=lambda event: (event[0], event[1]))
    return events


def _snap_to_kept(source_ms: int, intervals: list[tuple[int, int]]) -> int:
    """Pull a position inside a removed region forward to the next kept run."""
    for start, end in intervals:
        if source_ms < start:
            return start
        if source_ms <= end:
            return source_ms
    return intervals[-1][1] if intervals else 0


# Captions read better when a line breaks where the speaker pauses or changes
# than at an arbitrary character count, so these are ceilings, not targets.
MAX_CUE_MS = 6_000
MAX_CUE_CHARS = 84  # Two 42-character lines, the broadcast convention.
CUE_BREAK_GAP_MS = 700


def build_cues(
    timeline: EditTimeline,
    words: list[dict],
    speaker_by_word: dict[str, str] | None = None,
    speaker_names: dict[str, str] | None = None,
) -> list[Cue]:
    """Group surviving words into caption cues on the edited clock."""
    speaker_by_word = speaker_by_word or {}
    speaker_names = speaker_names or {}

    current_speaker: str | None = None
    pending: list[tuple[int, int, str]] = []
    pending_speaker: str | None = None
    cues: list[Cue] = []

    def flush() -> None:
        nonlocal pending
        if pending:
            text = " ".join(part for _, _, part in pending).strip()
            if text:
                cues.append(
                    Cue(
                        index=len(cues) + 1,
                        start=pending[0][0],
                        end=pending[-1][1],
                        text=text,
                        speaker=pending_speaker,
                    )
                )
        pending = []

    for word in words:
        speaker_id = speaker_by_word.get(str(word.get("id")))
        if speaker_id is not None:
            current_speaker = speaker_names.get(speaker_id, speaker_id)
        if word.get("isRemoved"):
            continue
        text = str(word.get("text", "")).strip()
        if not text:
            continue
        start = timeline.to_edited(float(word.get("startTime", 0)) * 1000)
        end = timeline.to_edited(float(word.get("endTime", 0)) * 1000)
        if start is None or end is None:
            continue
        end = max(end, start + 1)

        if pending:
            gap = start - pending[-1][1]
            length = end - pending[0][0]
            width = sum(len(part) + 1 for _, _, part in pending) + len(text)
            if (
                current_speaker != pending_speaker
                or gap > CUE_BREAK_GAP_MS
                or length > MAX_CUE_MS
                or width > MAX_CUE_CHARS
            ):
                flush()
        if not pending:
            pending_speaker = current_speaker
        pending.append((start, end, text))
    flush()
    return cues


def locate_anchor(timeline: EditTimeline, anchor: dict) -> tuple[Segment, int] | None:
    """Resolve a marker anchor to its segment and its position within it.

    Returns None when the anchor points at audio the edit removed, which is a
    normal outcome: markers survive the cut that deletes what they pointed at,
    and a delivery format simply has nowhere to put them.

    The returned offset is on the segment's own clock - source time for source
    segments, time from the clip's head for inserts - because that is what
    formats which nest markers inside clips expect.
    """
    insert_id = anchor.get("insertId")
    if insert_id:
        for segment in timeline.segments:
            if segment.kind == "insert" and segment.insert_id == insert_id:
                try:
                    offset = round(float(anchor.get("insertOffset") or 0.0) * 1000)
                except (TypeError, ValueError):
                    offset = 0
                return segment, max(0, min(segment.duration, offset))
        return None

    try:
        source_ms = round(float(anchor.get("sourceTime")) * 1000)
    except (TypeError, ValueError):
        return None
    for segment in timeline.segments:
        if segment.kind != "source":
            continue
        if segment.source_start <= source_ms <= segment.source_end:
            return segment, source_ms - segment.source_start
    return None


def total_cut_ms(timeline: EditTimeline) -> int:
    """How much of the original the edit removes; used in export summaries."""
    kept = sum(segment.duration for segment in timeline.segments if segment.kind == "source")
    return max(0, timeline.source_duration - kept)


def iter_source_segments(timeline: EditTimeline) -> Iterable[Segment]:
    return (segment for segment in timeline.segments if segment.kind == "source")
