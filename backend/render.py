"""Non-destructive source-interval renderer for ScriptSurgeon."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
import uuid
import wave
from pathlib import Path

from pydub import AudioSegment

CROSSFADE_MS = 10
SHORT_GAP_MS = 300
FFMPEG_BINARY = os.environ.get("SCRIPTCUT_FFMPEG", "ffmpeg")
AudioSegment.converter = FFMPEG_BINARY
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CLIP_ID_RE = re.compile(r"^[0-9a-f]{12}$")


def wav_duration(path: str) -> float | None:
    try:
        with wave.open(path, "rb") as handle:
            return round(handle.getnframes() / handle.getframerate(), 3)
    except Exception:
        return None


def gap_targets(gap_edits: list[dict] | list[str] | None) -> dict[str, int]:
    """Normalize modern exact pause edits and legacy shortened-ID lists."""
    targets: dict[str, int] = {}
    for item in gap_edits or []:
        if isinstance(item, str):
            targets[item] = SHORT_GAP_MS
            continue
        if not isinstance(item, dict):
            continue
        word_id = item.get("afterWordId")
        target = item.get("targetGapMs")
        if not isinstance(word_id, str):
            continue
        try:
            safe_target = int(target)
        except (TypeError, ValueError):
            continue
        if 50 <= safe_target <= 2000:
            targets[word_id] = safe_target
    return targets


def cut_intervals(words: list[dict], gap_edits: list[dict] | list[str], duration_ms: int) -> list[tuple[int, int]]:
    """Return merged source intervals to remove.

    Removed words cut only their recognized speech. Untouched leading/trailing audio,
    room tone, music, and ordinary pauses remain source audio. A shortened gap is
    valid only between adjacent original words that are both still present.
    """
    cuts: list[tuple[int, int]] = []
    targets = gap_targets(gap_edits)

    # A consecutive removed run is one edit, including pauses inside the run.
    index = 0
    while index < len(words):
        if not words[index].get("isRemoved"):
            index += 1
            continue
        first = index
        while index + 1 < len(words) and words[index + 1].get("isRemoved"):
            index += 1
        start = max(0, min(duration_ms, round(float(words[first]["startTime"]) * 1000)))
        end = max(start, min(duration_ms, round(float(words[index]["endTime"]) * 1000)))
        if end > start:
            cuts.append((start, end))
        index += 1

    for index, word in enumerate(words[:-1]):
        following = words[index + 1]
        target_gap_ms = targets.get(word["id"])
        if target_gap_ms is None or word.get("isRemoved") or following.get("isRemoved"):
            continue
        gap_start = max(0, min(duration_ms, round(float(word["endTime"]) * 1000)))
        gap_end = max(gap_start, min(duration_ms, round(float(following["startTime"]) * 1000)))
        gap = gap_end - gap_start
        if gap > target_gap_ms:
            # Retain room tone on both sides. The retained 310 ms becomes about
            # the configured target after the 10 ms edit-boundary crossfade.
            retained = min(gap, target_gap_ms + CROSSFADE_MS)
            keep_before = retained // 2
            cut_start = gap_start + keep_before
            cut_end = gap_end - (retained - keep_before)
            if cut_end > cut_start:
                cuts.append((cut_start, cut_end))
    if not cuts:
        return []
    cuts.sort()
    merged = [cuts[0]]
    for start, end in cuts[1:]:
        previous_start, previous_end = merged[-1]
        if start <= previous_end:
            merged[-1] = (previous_start, max(previous_end, end))
        else:
            merged.append((start, end))
    return merged


def kept_intervals(words: list[dict], gap_edits: list[dict] | list[str], duration_ms: int) -> list[tuple[int, int]]:
    cuts = cut_intervals(words, gap_edits, duration_ms)
    if not cuts:
        return [(0, duration_ms)] if duration_ms else []
    kept: list[tuple[int, int]] = []
    cursor = 0
    for start, end in cuts:
        if start > cursor:
            kept.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < duration_ms:
        kept.append((cursor, duration_ms))
    return kept


def state_hash(
    words: list[dict],
    gap_edits: list[dict] | list[str],
    studio: bool,
    insert_clips: list[dict] | None = None,
    noise: str = "off",
    normalize: bool = False,
    source_identity: str | None = None,
) -> str:
    payload = json.dumps({
        "words": [
            (word["id"], word.get("startTime"), word.get("endTime"), word.get("isRemoved", False))
            for word in words
        ],
        "gapEdits": sorted(gap_targets(gap_edits).items()),
        # Array order is significant for multiple takes at the same boundary.
        "insertClips": [
            (
                item.get("id"),
                item.get("clipId"),
                item.get("sourceTime"),
                item.get("duration"),
                item.get("isRemoved", False),
            )
            for item in (insert_clips or [])
        ],
        "studio": studio,
        "noise": normalized_noise(noise),
        "normalize": normalize,
        # A project can be re-recorded or recovered in place. Never reuse an
        # edited render that was composed from different original bytes merely
        # because its transcript edit state happens to be identical.
        "source": source_identity,
        # Bumped whenever the filter graph changes so cached renders from an
        # older chain are never served for the same edit state.
        "renderer": 7,
    }, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()[:20]


STUDIO_CHAIN = (
    "highpass=f=70,"
    "deesser=i=0.4:m=0.5:f=0.5,"
    "equalizer=f=200:t=q:w=1:g=-2,"
    "equalizer=f=3500:t=q:w=1:g=3,"
    "acompressor=threshold=-20dB:ratio=3:attack=8:release=120:makeup=4dB,"
    "alimiter=limit=0.94:attack=4:release=80"
)

# Split out of STUDIO_CHAIN so loudness can be matched without also applying
# EQ, de-essing, and compression. Targets the -16 LUFS spoken-word convention.
LOUDNORM_CHAIN = "loudnorm=I=-16:TP=-1.5:LRA=11"


# Background noise reduction. `afftdn` is spectral subtraction with noise
# tracking, which stays far cheaper than `anlmdn` (measured ~10x faster on a
# two-minute file) and so remains usable for the preview render that reruns on
# every edit. `nr` is how much is subtracted; `nf` is the assumed noise floor.
NOISE_CHAINS = {
    "light": "afftdn=nr=6:nf=-45:tn=1",
    "medium": "highpass=f=80,afftdn=nr=12:nf=-38:tn=1",
    "strong": "highpass=f=90,afftdn=nr=18:nf=-32:tn=1,afftdn=nr=8:nf=-40:tn=1",
}
NOISE_LEVELS = ("off", *NOISE_CHAINS)
MP3_BITRATE = "192k"


def normalized_noise(level: str | None) -> str:
    return level if level in NOISE_CHAINS else "off"


def filter_chain(studio: bool, noise: str, normalize: bool = False) -> str:
    """Order is fixed: denoise, then tone shaping, then loudness.

    Denoising first keeps compression from lifting the noise floor back up, and
    loudnorm runs last so it measures the audio that will actually be heard.
    """
    parts = []
    chain = NOISE_CHAINS.get(normalized_noise(noise))
    if chain:
        parts.append(chain)
    if studio:
        parts.append(STUDIO_CHAIN)
    if normalize:
        parts.append(LOUDNORM_CHAIN)
    return ",".join(parts)


def run_ffmpeg(arguments: list[str], purpose: str) -> None:
    completed = subprocess.run(
        [FFMPEG_BINARY, "-y", "-hide_banner", "-loglevel", "error", *arguments],
        text=True,
        capture_output=True,
        creationflags=NO_WINDOW,
    )
    if completed.returncode:
        raise RuntimeError(f"{purpose} failed: {completed.stderr.strip() or 'FFmpeg returned an error'}")


def apply_filters(input_wav: str, output_wav: str, chain: str) -> None:
    run_ffmpeg(["-i", input_wav, "-af", chain, "-ar", "44100", output_wav], "Audio cleanup")


def _ffmpeg_lacks_libmp3lame(error: RuntimeError) -> bool:
    """Recognize the one encoder gap that has a packaged fallback."""
    message = str(error).casefold()
    return "libmp3lame" in message and (
        "unknown encoder" in message or "encoder not found" in message
    )


def _encode_mp3_with_pyav(input_wav: str, output_mp3: str) -> None:
    """Encode a WAV with PyAV when the bundled CLI omits libmp3lame.

    The macOS CLI is deliberately built without third-party codec discovery.
    PyAV is already a required faster-whisper dependency and its supported
    macOS wheel supplies the MP3 encoder, so this preserves MP3 delivery
    without making the standalone CLI depend on Homebrew libraries.
    """
    try:
        import av

        with av.open(input_wav) as source:
            source_stream = next(
                (stream for stream in source.streams if stream.type == "audio"),
                None,
            )
            if source_stream is None:
                raise ValueError("input does not contain an audio stream")
            channels = int(getattr(source_stream.codec_context, "channels", 0) or 0)
            layout = "mono" if channels == 1 else "stereo"
            with av.open(output_mp3, "w", format="mp3") as destination:
                output_stream = destination.add_stream("libmp3lame", rate=44_100)
                output_stream.bit_rate = 192_000
                output_stream.layout = layout
                resampler = av.AudioResampler(
                    format="s16p",
                    layout=layout,
                    rate=44_100,
                )
                for frame in source.decode(source_stream):
                    for resampled in resampler.resample(frame):
                        for packet in output_stream.encode(resampled):
                            destination.mux(packet)
                for resampled in resampler.resample(None):
                    for packet in output_stream.encode(resampled):
                        destination.mux(packet)
                for packet in output_stream.encode(None):
                    destination.mux(packet)
    except Exception as exc:
        raise RuntimeError(f"MP3 encoding fallback failed: {exc}") from exc


def encode_mp3(input_wav: str, output_mp3: str) -> None:
    try:
        run_ffmpeg(
            ["-i", input_wav, "-c:a", "libmp3lame", "-b:a", MP3_BITRATE, "-ar", "44100", output_mp3],
            "MP3 encoding",
        )
    except RuntimeError as exc:
        if not _ffmpeg_lacks_libmp3lame(exc):
            raise
        _encode_mp3_with_pyav(input_wav, output_mp3)


def export_segment(
    input_wav: str,
    output_path: str,
    audio_format: str,
    start: float | None = None,
    end: float | None = None,
) -> None:
    """Cut [start, end) out of a finished render and encode it.

    `-t` is used rather than `-to` because `-to` is interpreted against
    different timebases depending on whether it precedes or follows `-i`.
    """
    arguments: list[str] = []
    begin = max(0.0, start or 0.0)
    if begin > 0:
        arguments += ["-ss", f"{begin:.3f}"]
    arguments += ["-i", input_wav]
    if end is not None:
        duration = end - begin
        if duration <= 0:
            raise ValueError("export range must end after it starts")
        arguments += ["-t", f"{duration:.3f}"]
    if audio_format != "mp3":
        arguments += ["-c:a", "pcm_s16le", "-ar", "44100", output_path]
        run_ffmpeg(arguments, "Range export")
        return

    try:
        run_ffmpeg(
            arguments + ["-c:a", "libmp3lame", "-b:a", MP3_BITRATE, "-ar", "44100", output_path],
            "Range export",
        )
    except RuntimeError as exc:
        if not _ffmpeg_lacks_libmp3lame(exc):
            raise
        output = Path(output_path)
        fallback_wav = output.with_name(f".{output.stem}-{uuid.uuid4().hex}.wav")
        try:
            run_ffmpeg(
                arguments + ["-c:a", "pcm_s16le", "-ar", "44100", str(fallback_wav)],
                "Range export preparation",
            )
            _encode_mp3_with_pyav(str(fallback_wav), output_path)
        finally:
            fallback_wav.unlink(missing_ok=True)


def source_fingerprint(original_path: str | Path) -> str:
    """Return a content identity for the immutable source asset.

    The renderer cannot safely infer media identity from its project directory:
    recovery, a replacement recording, or a restored backup can reuse that
    directory. Hashing the source itself makes decode and render caches correct
    across those transitions.
    """

    digest = hashlib.sha256()
    with Path(original_path).open("rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def decoded_source(original_path: str, project: Path, identity: str | None = None) -> Path:
    """Cache a PCM decode only while it matches the current source bytes."""
    original = Path(original_path)
    decoded = project / "source_pcm.wav"
    metadata = project / "source_pcm.identity.json"
    identity = identity or source_fingerprint(original)
    try:
        decoded_identity = json.loads(metadata.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        decoded_identity = None
    if decoded.exists() and isinstance(decoded_identity, dict) and decoded_identity.get("source") == identity:
        return decoded
    temporary = project / f".source-{uuid.uuid4().hex}.wav"
    temporary_metadata = project / f".source-identity-{uuid.uuid4().hex}.json"
    try:
        run_ffmpeg(["-i", str(original), "-map", "0:a:0", "-c:a", "pcm_s16le", str(temporary)], "Audio decoding")
        os.replace(temporary, decoded)
        temporary_metadata.write_text(
            json.dumps({"source": identity}, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(temporary_metadata, metadata)
    finally:
        temporary.unlink(missing_ok=True)
        temporary_metadata.unlink(missing_ok=True)
    return decoded


def recording_path(project: Path, clip_id: str) -> Path:
    """Resolve a strict immutable clip reference without accepting path input."""
    if not isinstance(clip_id, str) or not CLIP_ID_RE.fullmatch(clip_id):
        raise ValueError("invalid recording clip ID")
    project_root = project.resolve()
    recordings = (project / "recordings").resolve()
    if recordings.parent != project_root or recordings.name != "recordings":
        raise ValueError("recording storage is invalid")
    candidate = (recordings / f"{clip_id}.wav").resolve(strict=False)
    if (
        candidate.parent != recordings
        or candidate.name != f"{clip_id}.wav"
        or not candidate.is_file()
        or candidate.is_symlink()
    ):
        raise ValueError(f"recording clip {clip_id} is missing")
    return candidate


def timeline_segments(
    source: AudioSegment,
    intervals: list[tuple[int, int]],
    insert_clips: list[dict],
    project: Path,
) -> list[AudioSegment]:
    """Interleave retained source and active inserts in stable source order."""
    def edited_boundary(source_ms: int) -> int:
        """Collapse timestamps inside the same cut to its leading boundary."""
        cursor = 0
        for start, end in intervals:
            if start > cursor and cursor < source_ms < start:
                return cursor
            if source_ms <= end:
                return source_ms
            cursor = end
        if cursor < source_ms < len(source):
            return cursor
        return source_ms

    events: list[tuple[int, int, dict]] = []
    for order, item in enumerate(insert_clips):
        if item.get("isRemoved", False):
            continue
        try:
            seconds = float(item.get("sourceTime"))
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid insert source time") from exc
        if not math.isfinite(seconds):
            raise ValueError("invalid insert source time")
        source_ms = edited_boundary(max(0, min(len(source), round(seconds * 1000))))
        events.append((source_ms, order, item))
    events.sort(key=lambda event: (event[0], event[1]))

    remaining = [[start, end] for start, end in intervals]
    interval_index = 0
    segments: list[AudioSegment] = []
    for source_ms, _, item in events:
        while interval_index < len(remaining):
            start, end = remaining[interval_index]
            if end <= source_ms:
                if end > start:
                    segments.append(source[start:end])
                interval_index += 1
                continue
            if start < source_ms:
                segments.append(source[start:source_ms])
                remaining[interval_index][0] = source_ms
            break

        clip_path = recording_path(project, item.get("clipId"))
        with clip_path.open("rb") as clip_handle:
            clip = AudioSegment.from_wav(clip_handle)
        if len(clip):
            segments.append(clip)

    while interval_index < len(remaining):
        start, end = remaining[interval_index]
        if end > start:
            segments.append(source[start:end])
        interval_index += 1
    return segments


def render_edited(
    original_path: str,
    words: list[dict],
    gap_edits: list[dict] | list[str],
    studio: bool,
    project_dir: str,
    insert_clips: list[dict] | None = None,
    noise: str = "off",
    normalize: bool = False,
) -> str:
    """Render current edits to WAV, preserving all source audio outside explicit cuts."""
    insert_clips = insert_clips or []
    identity = source_fingerprint(original_path)
    digest = state_hash(words, gap_edits, studio, insert_clips, noise, normalize, identity)
    project = Path(project_dir)
    output = project / f"render_{digest}.wav"
    if output.exists():
        return str(output)

    source_path = decoded_source(original_path, project, identity)
    with source_path.open("rb") as source_handle:
        source = AudioSegment.from_wav(source_handle)
    intervals = kept_intervals(words, gap_edits, len(source))
    segments = timeline_segments(source, intervals, insert_clips, project)
    result: AudioSegment | None = None
    previous_segment_length = 0
    for segment in segments:
        if not len(segment):
            continue
        if result is None:
            result = segment
        else:
            crossfade = min(CROSSFADE_MS, previous_segment_length, len(segment))
            result = result.append(segment, crossfade=crossfade)
        previous_segment_length = len(segment)
    if result is None:
        result = AudioSegment.silent(duration=0, frame_rate=source.frame_rate or 44100)

    temporary = project / f".render-{digest}-{uuid.uuid4().hex}.wav"
    filtered_tmp = project / f".filtered-{digest}-{uuid.uuid4().hex}.wav"
    chain = filter_chain(studio, noise, normalize)
    try:
        exported = result.export(str(temporary), format="wav")
        exported.close()
        if chain and len(result):
            apply_filters(str(temporary), str(filtered_tmp), chain)
            os.replace(filtered_tmp, output)
        else:
            os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
        filtered_tmp.unlink(missing_ok=True)

    return str(output)
