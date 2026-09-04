"""ScriptSurgeon's local-only API and transcription job runner."""
from __future__ import annotations

import hmac
import json
import logging
import math
import mimetypes
import os
import queue
import re
import shutil
import threading
import unicodedata
import uuid
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.build_identity import build_identity

PACKAGE_DIR = Path(__file__).resolve().parent
SOURCE_ROOT = PACKAGE_DIR.parent
RESOURCE_ROOT = Path(os.environ.get("SCRIPTCUT_RESOURCE_DIR", SOURCE_ROOT)).resolve()
DATA_ROOT = Path(os.environ.get("SCRIPTCUT_DATA_DIR", SOURCE_ROOT)).resolve()
PROJECTS_DIR = DATA_ROOT / "projects"
DIST_DIR = RESOURCE_ROOT / "frontend" / "dist"
MAX_UPLOAD_BYTES = int(os.environ.get("SCRIPTCUT_MAX_UPLOAD_BYTES", 2 * 1024**3))
MAX_AUDIO_SECONDS = float(os.environ.get("SCRIPTCUT_MAX_AUDIO_SECONDS", 2 * 60 * 60))
MAX_RECORDING_BYTES = int(os.environ.get("SCRIPTCUT_MAX_RECORDING_BYTES", 128 * 1024**2))
MAX_RECORDING_SECONDS = float(os.environ.get("SCRIPTCUT_MAX_RECORDING_SECONDS", 10 * 60))
MAX_RECORDING_STORAGE_BYTES = int(os.environ.get("SCRIPTCUT_MAX_RECORDING_STORAGE_BYTES", 2 * 1024**3))
MAX_INSERT_CLIPS = 1_000
PROJECT_ID_RE = re.compile(r"^[0-9a-f]{12}$")
WORD_ID_RE = re.compile(r"^[0-9a-f]{10}$")
INSERT_ID_RE = re.compile(r"^[0-9a-f]{12}$")
CLIP_ID_RE = re.compile(r"^[0-9a-f]{12}$")
CREATION_ID_RE = re.compile(r"^[0-9a-f]{32}$")
ALLOWED_EXT = {".mp3", ".wav", ".m4a", ".mp4", ".aac", ".ogg", ".flac"}
RECORDING_EXT = ALLOWED_EXT | {".webm"}
RECORDING_MIME = {
    "audio/aac",
    "audio/flac",
    "audio/mpeg",
    "audio/mp3",
    "audio/ogg",
    "audio/webm",
    "video/webm",
    "audio/mp4",
    "video/mp4",
    "audio/wav",
    "audio/x-wav",
    "audio/x-flac",
    "audio/x-m4a",
    "audio/wave",
    "application/ogg",
}
RECORDING_MIME_EXT = {
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/ogg": ".ogg",
    "audio/webm": ".webm",
    "video/webm": ".webm",
    "audio/mp4": ".m4a",
    "video/mp4": ".mp4",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/x-flac": ".flac",
    "audio/x-m4a": ".m4a",
    "audio/wave": ".wav",
    "application/ogg": ".ogg",
}

logger = logging.getLogger(__name__)

PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

status_lock = threading.RLock()
statuses: dict[str, dict[str, Any]] = {}
project_locks_lock = threading.Lock()
project_locks: dict[str, threading.RLock] = {}
render_lease_lock = threading.Lock()
render_leases: dict[str, int] = {}
recording_uploads: dict[str, int] = {}
cancel_events: dict[str, threading.Event] = {}
job_queue: queue.Queue[tuple[str, str]] = queue.Queue()
queued_ids: set[str] = set()
worker_started = False
worker_start_lock = threading.Lock()
creation_lock = threading.Lock()
creating_project_ids: set[str] = set()


def atomic_json(path: Path, payload: Any) -> None:
    """Publish JSON atomically so an interrupted save cannot corrupt a project."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with tmp.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _project_path(pid: str, require_exists: bool) -> Path:
    if not PROJECT_ID_RE.fullmatch(pid):
        raise HTTPException(404, "project not found")
    root = PROJECTS_DIR.resolve()
    candidate = PROJECTS_DIR / pid
    try:
        resolved = candidate.resolve(strict=require_exists)
    except (FileNotFoundError, OSError):
        raise HTTPException(404, "project not found") from None
    # This also rejects symlinks/junctions that resolve outside the project root.
    if resolved.parent != root or resolved.name != pid:
        raise HTTPException(404, "project not found")
    if require_exists and not resolved.is_dir():
        raise HTTPException(404, "project not found")
    return resolved


def pdir(pid: str) -> Path:
    return _project_path(pid, require_exists=True)


def creation_root() -> Path:
    """Return the stable, non-project staging container for new uploads."""
    root = PROJECTS_DIR.resolve()
    candidate = PROJECTS_DIR / ".creating"
    candidate.mkdir(parents=False, exist_ok=True)
    resolved = candidate.resolve()
    if candidate.is_symlink() or resolved.parent != root or resolved.name != ".creating":
        raise RuntimeError("project creation staging is invalid")
    return resolved


def remove_creation_stage(stage: Path) -> None:
    """Remove only a strict direct child of ScriptSurgeon's internal staging root."""
    try:
        root = creation_root()
        if stage.is_symlink():
            return
        resolved = stage.resolve(strict=True)
        if resolved.parent != root or not CREATION_ID_RE.fullmatch(resolved.name):
            return
        shutil.rmtree(resolved)
    except (FileNotFoundError, OSError):
        pass


def cleanup_creation_stages() -> None:
    """Discard every abandoned stage before this single-instance API starts."""
    try:
        root = creation_root()
        candidates = list(root.iterdir())
    except OSError:
        return
    for candidate in candidates:
        try:
            if (
                candidate.is_symlink()
                or not CREATION_ID_RE.fullmatch(candidate.name)
                or not candidate.is_dir()
            ):
                continue
            remove_creation_stage(candidate)
        except OSError:
            continue


def reserve_project_id() -> str:
    """Reserve a collision-free ID within this single-process backend."""
    with creation_lock:
        while True:
            pid = uuid.uuid4().hex[:12]
            if pid not in creating_project_ids and not _project_path(pid, require_exists=False).exists():
                creating_project_ids.add(pid)
                return pid


def release_project_id(pid: str) -> None:
    with creation_lock:
        creating_project_ids.discard(pid)


def source_extension(file: UploadFile) -> str:
    """Choose an allowlisted storage suffix; never persist an untrusted suffix."""
    ext = Path(file.filename or "").suffix.lower()
    if ext in RECORDING_EXT:
        return ext
    media_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    mapped = RECORDING_MIME_EXT.get(media_type)
    if mapped:
        return mapped
    raise HTTPException(400, f"unsupported file type {ext or '(none)'}")


def normalized_project_name(value: str | None, filename: str | None) -> str:
    """Validate an explicit display name while preserving filename fallback."""
    explicit = value is not None
    candidate = value if explicit else Path(filename or "Untitled").stem
    candidate = unicodedata.normalize("NFC", candidate).strip()
    if not candidate:
        if explicit:
            raise HTTPException(400, "project name must not be empty")
        candidate = "Untitled"
    if any(unicodedata.category(char) == "Cc" for char in candidate):
        raise HTTPException(400, "project name contains control characters")
    if len(candidate) > 160:
        if explicit:
            raise HTTPException(400, "project name must be 160 characters or fewer")
        candidate = candidate[:160]
    return candidate


def project_lock(pid: str) -> threading.RLock:
    with project_locks_lock:
        return project_locks.setdefault(pid, threading.RLock())


def acquire_render_lease(path: Path) -> None:
    key = str(path.resolve())
    with render_lease_lock:
        render_leases[key] = render_leases.get(key, 0) + 1


def release_render_lease(path: Path) -> None:
    key = str(path.resolve())
    with render_lease_lock:
        count = render_leases.get(key, 0)
        if count <= 1:
            render_leases.pop(key, None)
        else:
            render_leases[key] = count - 1


def prune_render_cache(directory: Path, current: Path, keep: int = 4) -> None:
    with render_lease_lock:
        leased = set(render_leases)
    renders = sorted(directory.glob("render_*.wav"), key=lambda item: item.stat().st_mtime, reverse=True)
    protected = {str(current.resolve()), *leased}
    retained = 0
    for candidate in renders:
        resolved = str(candidate.resolve())
        if resolved in protected or retained < keep:
            retained += 1
            continue
        try:
            candidate.unlink()
        except OSError:
            pass


def meta_path(directory: Path) -> Path:
    return directory / "meta.json"


def state_path(directory: Path) -> Path:
    return directory / "state.json"


def status_path(directory: Path) -> Path:
    return directory / "status.json"


def original_file(directory: Path) -> Path:
    originals = sorted(f for f in directory.iterdir() if f.is_file() and f.name.startswith("original."))
    if not originals:
        raise HTTPException(500, "original audio missing")
    return originals[0]


def recordings_dir(directory: Path, create: bool = False) -> Path:
    """Return the non-user-addressable directory containing immutable takes."""
    root = directory.resolve()
    candidate = directory / "recordings"
    if create:
        candidate.mkdir(parents=False, exist_ok=True)
    resolved = candidate.resolve()
    if resolved.parent != root or resolved.name != "recordings":
        raise HTTPException(400, "recording storage is invalid")
    return resolved


def recording_file(directory: Path, clip_id: str, require_exists: bool = True) -> Path:
    if not CLIP_ID_RE.fullmatch(clip_id):
        raise HTTPException(400, "invalid recording clip ID")
    root = recordings_dir(directory)
    candidate = (root / f"{clip_id}.wav").resolve(strict=False)
    if candidate.parent != root or candidate.name != f"{clip_id}.wav":
        raise HTTPException(400, "invalid recording clip path")
    if require_exists and (not candidate.is_file() or candidate.is_symlink()):
        raise HTTPException(400, f"recording clip {clip_id} is missing")
    return candidate


def recording_storage_bytes(directory: Path) -> int:
    try:
        root = recordings_dir(directory)
    except HTTPException:
        return 0
    total = 0
    for candidate in root.glob("*.wav"):
        try:
            if candidate.is_file() and not candidate.is_symlink() and candidate.resolve().parent == root:
                total += candidate.stat().st_size
        except OSError:
            continue
    return total


def set_status(pid: str, **values: Any) -> None:
    with status_lock:
        status = statuses.setdefault(pid, {})
        status.update(values)
        snapshot = dict(status)
    try:
        with project_lock(pid):
            directory = _project_path(pid, require_exists=True)
            atomic_json(status_path(directory), snapshot)
    except HTTPException:
        # A deletion can legitimately race a cancelled background job.
        with status_lock:
            statuses.pop(pid, None)
    except OSError:
        pass


def get_status(pid: str) -> dict[str, Any]:
    with status_lock:
        if pid in statuses:
            return dict(statuses[pid])
    directory = pdir(pid)
    try:
        status = read_json(status_path(directory))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        status = {"status": "ready" if state_path(directory).exists() else "queued", "progress": 1 if state_path(directory).exists() else 0}
    with status_lock:
        statuses[pid] = status
    return dict(status)


def load_project(pid: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
    directory = pdir(pid)
    try:
        meta = read_json(meta_path(directory))
        state = read_json(state_path(directory)) if state_path(directory).exists() else None
        if state is not None:
            # Legacy projects predate durable cleanup overrides. Normalize the
            # API response without rewriting their state file on read.
            state.setdefault("cleanupKeepWordIds", [])
            state.setdefault("cleanupKeepGapIds", [])
            state.setdefault("insertClips", [])
            state.setdefault("retakeGroups", [])
            # Per-gap timing is additive. Old projects retain the established
            # 300 ms pacing until the owner changes an individual pause.
            state.setdefault("gapPacing", {
                "preset": "podcast",
                "detectionThresholdMs": 800,
                "targetGapMs": 300,
            })
            # A brief mixed-version window can contain the legacy ID list plus
            # an empty/newer `gapEdits` list. Merge the two in the response so
            # rendering and the editor use the exact same canonical gaps before
            # the next save. This is intentionally read-only migration.
            canonical_gap_edits: list[dict[str, Any]] = []
            seen_gap_ids: set[str] = set()
            for item in state.get("gapEdits", []):
                if not isinstance(item, dict):
                    continue
                word_id = item.get("afterWordId")
                target = item.get("targetGapMs", 300)
                if not isinstance(word_id, str) or word_id in seen_gap_ids:
                    continue
                if not isinstance(target, int) or isinstance(target, bool) or not 50 <= target <= 2_000:
                    target = 300
                seen_gap_ids.add(word_id)
                canonical_gap_edits.append({"afterWordId": word_id, "targetGapMs": target})
            for word_id in state.get("shortenedGapIds", []):
                if isinstance(word_id, str) and word_id not in seen_gap_ids:
                    seen_gap_ids.add(word_id)
                    canonical_gap_edits.append({"afterWordId": word_id, "targetGapMs": 300})
            state["gapEdits"] = canonical_gap_edits
            state["shortenedGapIds"] = [item["afterWordId"] for item in canonical_gap_edits]
            state.setdefault("markers", [])
    except (json.JSONDecodeError, OSError) as exc:
        raise HTTPException(500, f"project data is damaged: {exc}") from exc
    return meta, state


def validate_media(path: Path) -> tuple[float | None, int | None, int | None]:
    """Verify decodable, non-empty audio and enforce its bounded duration."""
    try:
        import av

        with av.open(str(path)) as container:
            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is None:
                raise ValueError("the file does not contain an audio track")
            metadata_duration = None
            if stream.duration is not None and stream.time_base is not None:
                metadata_duration = float(stream.duration * stream.time_base)
            elif container.duration is not None:
                metadata_duration = float(container.duration / av.time_base)
            if metadata_duration is not None and (
                not math.isfinite(metadata_duration) or metadata_duration <= 0
            ):
                metadata_duration = None
            if metadata_duration is not None and metadata_duration > MAX_AUDIO_SECONDS:
                raise ValueError(f"audio is longer than the {MAX_AUDIO_SECONDS / 3600:g}-hour limit")

            sample_rate = getattr(stream.codec_context, "sample_rate", None)
            sample_rate = int(sample_rate) if sample_rate else None
            channels = getattr(stream.codec_context, "channels", None)
            channels = int(channels) if channels else None
            decoded_duration = 0.0
            first_timestamp: float | None = None
            last_timestamp: float | None = None
            scan_entire_stream = metadata_duration is None
            for frame in container.decode(stream):
                frame_samples = int(getattr(frame, "samples", 0) or 0)
                frame_rate = int(getattr(frame, "sample_rate", 0) or sample_rate or 0)
                if frame_samples <= 0 or frame_rate <= 0:
                    continue
                if sample_rate is None:
                    sample_rate = frame_rate
                frame_duration = frame_samples / frame_rate
                decoded_duration += frame_duration

                pts = getattr(frame, "pts", None)
                time_base = getattr(frame, "time_base", None)
                if pts is not None and time_base is not None:
                    timestamp = float(pts * time_base)
                    if math.isfinite(timestamp):
                        first_timestamp = timestamp if first_timestamp is None else min(first_timestamp, timestamp)
                        frame_end = timestamp + frame_duration
                        last_timestamp = frame_end if last_timestamp is None else max(last_timestamp, frame_end)

                timeline_duration = (
                    max(0.0, last_timestamp - first_timestamp)
                    if first_timestamp is not None and last_timestamp is not None
                    else 0.0
                )
                observed_duration = max(decoded_duration, timeline_duration)
                if observed_duration > MAX_AUDIO_SECONDS + 0.001:
                    raise ValueError(f"audio is longer than the {MAX_AUDIO_SECONDS / 3600:g}-hour limit")
                if not scan_entire_stream:
                    break

            if decoded_duration <= 0:
                raise ValueError("the media file contains no decodable audio")
            if metadata_duration is None:
                metadata_duration = max(
                    decoded_duration,
                    max(0.0, last_timestamp - first_timestamp)
                    if first_timestamp is not None and last_timestamp is not None
                    else 0.0,
                )
            if metadata_duration <= 0:
                raise ValueError("the media file contains no decodable audio")
            return metadata_duration, sample_rate, channels
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"could not read this media file ({exc})") from exc


def canonicalize_recording(source: Path, destination: Path) -> float:
    """Decode a bounded browser recording into the immutable insert format."""
    duration, _, _ = validate_media(source)
    if duration is not None:
        if duration <= 0:
            raise ValueError("the recording is empty")
        if duration > MAX_RECORDING_SECONDS + 0.001:
            raise ValueError(f"recording is longer than the {MAX_RECORDING_SECONDS / 60:g}-minute limit")

    from .render import run_ffmpeg, wav_duration

    # Decode at most one second beyond the limit. This bounds PCM expansion for
    # formats whose container does not publish a trustworthy duration.
    run_ffmpeg([
        "-i", str(source),
        "-map", "0:a:0",
        "-vn",
        "-t", f"{MAX_RECORDING_SECONDS + 1:.3f}",
        "-ac", "1",
        "-ar", "48000",
        "-c:a", "pcm_s16le",
        "-f", "wav",
        str(destination),
    ], "Recording decoding")
    canonical_duration = wav_duration(str(destination))
    if canonical_duration is None or canonical_duration <= 0:
        raise ValueError("the recording is empty or unreadable")
    if canonical_duration > MAX_RECORDING_SECONDS + 0.001:
        raise ValueError(f"recording is longer than the {MAX_RECORDING_SECONDS / 60:g}-minute limit")
    try:
        with wave.open(str(destination), "rb") as handle:
            if handle.getnchannels() != 1 or handle.getframerate() != 48_000 or handle.getsampwidth() != 2:
                raise ValueError("the recording could not be canonicalized")
    except (OSError, wave.Error) as exc:
        raise ValueError("the recording could not be canonicalized") from exc
    return canonical_duration


class TranscriptionCancelled(Exception):
    pass


def run_transcription(pid: str, audio_path: str) -> None:
    with status_lock:
        event = cancel_events.setdefault(pid, threading.Event())
    try:
        from .transcribe import transcribe_words

        set_status(pid, status="transcribing", stage="preparing_model", message="Preparing the local speech model", progress=0.01, error=None)

        def progress(value: float) -> None:
            if event.is_set():
                raise TranscriptionCancelled()
            set_status(pid, status="transcribing", stage="transcribing", message="Transcribing on this computer", progress=round(value, 3))

        words, duration, sample_rate = transcribe_words(audio_path, progress_cb=progress)
        if event.is_set():
            raise TranscriptionCancelled()
        # Treat model output as untrusted until it satisfies the same schema and
        # source bounds as client-saved state. A damaged/partial model result
        # must fail the job without publishing a project that the editor cannot
        # subsequently load or render.
        if (
            isinstance(duration, bool)
            or not isinstance(duration, (int, float))
            or not math.isfinite(float(duration))
            or not 0 < float(duration) <= MAX_AUDIO_SECONDS
        ):
            raise RuntimeError("transcription returned an invalid source duration")
        duration = float(duration)
        if sample_rate is not None and (
            isinstance(sample_rate, bool)
            or not isinstance(sample_rate, int)
            or sample_rate <= 0
        ):
            raise RuntimeError("transcription returned an invalid source sample rate")
        directory = pdir(pid)
        with project_lock(pid):
            state = {
                "words": words,
                "shortenedGapIds": [],
                "gapPacing": {
                    "preset": "podcast",
                    "detectionThresholdMs": 800,
                    "targetGapMs": 300,
                },
                "gapEdits": [],
                "studioSound": False,
                "noiseReduction": "off",
                "normalizeLoudness": False,
                "speakers": [],
                "speakerByWord": {},
                "collapsedRetakes": [],
                "retakeGroups": [],
                "cleanupKeepWordIds": [],
                "cleanupKeepGapIds": [],
                "insertClips": [],
                "markers": [],
                "revision": 1,
            }
            try:
                StatePayload.model_validate(state)
                validate_state_source_bounds(state, duration)
            except (ValidationError, HTTPException) as exc:
                raise RuntimeError("transcription returned invalid word timing data") from exc
            meta = read_json(meta_path(directory))
            meta.update(duration=duration, sampleRate=sample_rate)
            atomic_json(meta_path(directory), meta)
            atomic_json(state_path(directory), state)
        set_status(pid, status="ready", stage="ready", message="Ready to edit", progress=1.0, error=None)
    except TranscriptionCancelled:
        set_status(pid, status="cancelled", stage="cancelled", message="Transcription cancelled", error=None)
    except Exception as exc:  # background jobs must surface useful errors in the UI
        set_status(pid, status="error", stage="error", message="Transcription failed", error=str(exc))
    finally:
        with status_lock:
            queued_ids.discard(pid)
            # Retain a newer retry event if one was installed after this job;
            # otherwise completed/deleted projects should not leak one Event
            # object for the rest of the desktop process lifetime.
            if cancel_events.get(pid) is event:
                cancel_events.pop(pid, None)


def transcription_worker() -> None:
    while True:
        pid, audio_path = job_queue.get()
        try:
            run_transcription(pid, audio_path)
        finally:
            job_queue.task_done()


def start_worker() -> None:
    global worker_started
    with worker_start_lock:
        if worker_started:
            return
        threading.Thread(target=transcription_worker, name="scriptsurgeon-transcriber", daemon=True).start()
        worker_started = True


def enqueue_transcription(pid: str, audio_path: Path) -> None:
    with status_lock:
        if pid in queued_ids:
            return
        queued_ids.add(pid)
        # Install the cancellation handle atomically with the queued marker so
        # deletion cannot set one Event while enqueue replaces it with another.
        cancel_events[pid] = threading.Event()
    set_status(pid, status="queued", stage="queued", message="Waiting for the local transcriber", progress=0, error=None)
    job_queue.put((pid, str(audio_path)))


def resume_incomplete_projects() -> None:
    for candidate in PROJECTS_DIR.iterdir():
        if not PROJECT_ID_RE.fullmatch(candidate.name):
            continue
        try:
            # Apply the same strict immediate-child and symlink/junction checks
            # used by every API route before reading or enqueueing project data.
            directory = _project_path(candidate.name, require_exists=True)
        except HTTPException:
            continue
        if state_path(directory).exists():
            try:
                read_json(meta_path(directory))
                original_file(directory)
                StatePayload.model_validate(read_json(state_path(directory)))
                set_status(
                    directory.name,
                    status="ready",
                    stage="ready",
                    message="Ready to edit",
                    progress=1.0,
                    error=None,
                )
            except (HTTPException, ValidationError, json.JSONDecodeError, OSError) as exc:
                set_status(
                    directory.name,
                    status="error",
                    stage="error",
                    message="Project state is damaged",
                    error=str(exc),
                )
            continue
        try:
            if status_path(directory).exists():
                persisted = read_json(status_path(directory))
                if persisted.get("status") in {"error", "cancelled"}:
                    continue
            enqueue_transcription(directory.name, original_file(directory))
        except (HTTPException, json.JSONDecodeError, OSError):
            continue


@asynccontextmanager
async def lifespan(_: FastAPI):
    cleanup_creation_stages()
    start_worker()
    resume_incomplete_projects()
    yield


desktop_mode = os.environ.get("SCRIPTCUT_DESKTOP") == "1"
app = FastAPI(
    title="ScriptSurgeon",
    docs_url=None if desktop_mode else "/docs",
    redoc_url=None if desktop_mode else "/redoc",
    lifespan=lifespan,
)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])


@app.middleware("http")
async def require_desktop_token(request: Request, call_next):
    token = os.environ.get("SCRIPTCUT_SESSION_TOKEN", "")
    if token and request.url.path.startswith("/api/") and request.url.path != "/api/health":
        supplied = request.headers.get("X-ScriptCut-Token", "")
        if not hmac.compare_digest(token, supplied):
            return JSONResponse({"detail": "invalid desktop session"}, status_code=403)
    return await call_next(request)


class WordState(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    id: str = Field(pattern=r"^[0-9a-f]{10}$")
    text: str = Field(max_length=500)
    startTime: float = Field(ge=0, le=MAX_AUDIO_SECONDS)
    endTime: float = Field(ge=0, le=MAX_AUDIO_SECONDS)
    isFiller: bool = False
    isRetake: bool = False
    isRemoved: bool = False
    gapAfter: float = Field(default=0, ge=0, le=MAX_AUDIO_SECONDS)
    # Faster-whisper exposes this only for some model/runtime combinations.
    # It is informational evidence for review, never an audio/VAD claim.
    asrConfidence: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def ordered_times(self):
        if self.endTime < self.startTime:
            raise ValueError("word endTime must not precede startTime")
        return self


class InsertClipState(BaseModel):
    """A logical transcript insert that references an immutable local take."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, str_strip_whitespace=True)

    id: str = Field(pattern=r"^[0-9a-f]{12}$")
    clipId: str = Field(pattern=r"^[0-9a-f]{12}$")
    sourceTime: float = Field(ge=0, le=MAX_AUDIO_SECONDS)
    duration: float = Field(gt=0, le=MAX_RECORDING_SECONDS)
    text: str = Field(min_length=1, max_length=500)
    afterWordId: str | None = Field(default=None, pattern=r"^[0-9a-f]{10}$")
    isRemoved: bool = False


class SpeakerState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[0-9a-f]{8}$")
    name: str = Field(min_length=1, max_length=60)


class GapPacingState(BaseModel):
    """Defaults for new pause suggestions; existing edits stay exact."""

    model_config = ConfigDict(extra="forbid")

    preset: Literal["conversation", "podcast", "tight", "custom"] = "podcast"
    detectionThresholdMs: int = Field(default=800, ge=200, le=5000)
    targetGapMs: int = Field(default=300, ge=50, le=2000)

    @model_validator(mode="after")
    def sensible_pacing(self):
        if self.targetGapMs >= self.detectionThresholdMs:
            raise ValueError("gap target must be shorter than the detection threshold")
        return self


class GapEditState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    afterWordId: str = Field(pattern=r"^[0-9a-f]{10}$")
    targetGapMs: int = Field(ge=50, le=2000)


class RetakeGroupState(BaseModel):
    """A durable, reviewable alternate-take choice."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[0-9a-f]{12}$")
    candidates: list[list[str]] = Field(min_length=2, max_length=64)
    recommendedKeepIndex: int = Field(ge=0, le=63)
    selectedKeepIndex: int = Field(ge=0, le=63)

    @model_validator(mode="after")
    def bounded_candidates(self):
        if any(not candidate or len(candidate) > 2_000 for candidate in self.candidates):
            raise ValueError("retake candidates must contain a bounded word sequence")
        if self.recommendedKeepIndex >= len(self.candidates) or self.selectedKeepIndex >= len(self.candidates):
            raise ValueError("retake keep choices must reference a candidate")
        flattened = [word_id for candidate in self.candidates for word_id in candidate]
        if len(flattened) != len(set(flattened)):
            raise ValueError("retake candidates may not overlap")
        return self


class MarkerAnchorState(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    sourceTime: float = Field(ge=0, le=MAX_AUDIO_SECONDS)
    insertId: str | None = Field(default=None, pattern=r"^[0-9a-f]{12}$")
    insertOffset: float | None = Field(default=None, ge=0, le=MAX_RECORDING_SECONDS)

    @model_validator(mode="after")
    def paired_insert_anchor(self):
        if (self.insertId is None) != (self.insertOffset is None):
            raise ValueError("marker insert anchors need both an ID and offset")
        return self


class MarkerState(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, str_strip_whitespace=True)

    id: str = Field(pattern=r"^[0-9a-f]{12}$")
    title: str = Field(min_length=1, max_length=120)
    kind: Literal["marker", "chapter"] = "marker"
    anchor: MarkerAnchorState
    end: MarkerAnchorState | None = None

    @field_validator("title")
    @classmethod
    def printable_title(cls, value: str):
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("marker titles may not contain control characters")
        return value


class RetakeDiagnosticPayload(BaseModel):
    """Count-only local analysis telemetry; it deliberately has no text/audio."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    correlationId: str = Field(pattern=r"^[0-9a-f]{32}$")
    # The local project owns exactly one immutable original-media asset. Keep
    # both names explicit in diagnostics so support tooling does not infer a
    # filename or path to identify the media.
    projectId: str = Field(pattern=r"^[0-9a-f]{12}$")
    mediaAssetId: str = Field(pattern=r"^[0-9a-f]{12}$")
    jobId: str = Field(pattern=r"^[0-9a-f]{32}$")
    jobStatus: Literal["completed", "failed"]
    stage: Literal["retake-preview"]
    transcriptRevision: int = Field(ge=0, le=2**63 - 1)
    wordCount: int = Field(ge=0, le=500_000)
    sourceStart: float = Field(ge=0, le=MAX_AUDIO_SECONDS)
    sourceEnd: float = Field(ge=0, le=MAX_AUDIO_SECONDS)
    sourceDuration: float = Field(ge=0, le=MAX_AUDIO_SECONDS)
    processedDuration: float = Field(ge=0, le=MAX_AUDIO_SECONDS)
    sourceSampleRate: int | None = Field(default=None, ge=1, le=384_000)
    sourceChannels: int | None = Field(default=None, ge=1, le=64)
    # Retake preview analyzes transcript state; it does not create a new media
    # artifact. These remain null unless an actual processed format is known.
    processedSampleRate: int | None = Field(default=None, ge=1, le=384_000)
    processedChannels: int | None = Field(default=None, ge=1, le=64)
    candidateWindows: int = Field(ge=0, le=5_000_000)
    rejected: dict[str, int] = Field(default_factory=dict, max_length=32)
    groups: int = Field(ge=0, le=100_000)
    suggestions: int = Field(ge=0, le=100_000)
    noiseReduction: Literal["off", "light", "medium", "strong"] = "off"
    # Failure evidence must remain structural: no exception message, stack,
    # source path, transcript text, or media filename enters this event.
    exceptionType: Literal["Error", "TypeError", "RangeError", "SyntaxError", "UnknownError"] | None = None
    exceptionLocation: Literal["retake-preview"] | None = None

    @field_validator("rejected")
    @classmethod
    def bounded_rejection_counts(cls, value: dict[str, int]):
        if any(not re.fullmatch(r"[a-z0-9-]{1,64}", key) or count < 0 or count > 5_000_000 for key, count in value.items()):
            raise ValueError("diagnostic rejection counts must be bounded stage names")
        return value

    @model_validator(mode="after")
    def bounded_lifecycle(self):
        if self.mediaAssetId != self.projectId:
            raise ValueError("media asset ID must match its local project ID")
        if self.jobId != self.correlationId:
            raise ValueError("diagnostic job ID must match its correlation ID")
        if self.sourceStart > self.sourceEnd or self.sourceEnd > self.sourceDuration + 0.001:
            raise ValueError("diagnostic source range must fit its source duration")
        has_exception = self.exceptionType is not None or self.exceptionLocation is not None
        if self.jobStatus == "completed" and has_exception:
            raise ValueError("completed diagnostics may not include exception fields")
        if self.jobStatus == "failed" and (self.exceptionType is None or self.exceptionLocation is None):
            raise ValueError("failed diagnostics need a type and bounded location")
        return self


class StatePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    words: list[WordState] = Field(max_length=500_000)
    shortenedGapIds: list[str] = Field(default_factory=list, max_length=500_000)
    gapPacing: GapPacingState = Field(default_factory=GapPacingState)
    gapEdits: list[GapEditState] = Field(default_factory=list, max_length=500_000)
    studioSound: bool = False
    noiseReduction: Literal["off", "light", "medium", "strong"] = "off"
    normalizeLoudness: bool = False
    speakers: list[SpeakerState] = Field(default_factory=list, max_length=64)
    # wordId -> speakerId, only where the speaker changes.
    speakerByWord: dict[str, str] = Field(default_factory=dict)
    collapsedRetakes: list[list[str]] = Field(default_factory=list, max_length=100_000)
    retakeGroups: list[RetakeGroupState] = Field(default_factory=list, max_length=100_000)
    cleanupKeepWordIds: list[str] = Field(default_factory=list, max_length=500_000)
    cleanupKeepGapIds: list[str] = Field(default_factory=list, max_length=500_000)
    insertClips: list[InsertClipState] = Field(default_factory=list, max_length=MAX_INSERT_CLIPS)
    markers: list[MarkerState] = Field(default_factory=list, max_length=10_000)
    # Persisted states contain the server-owned revision. Accept it when reading
    # existing state, but never copy a client-supplied value back to disk.
    revision: int | None = Field(default=None, ge=0, le=2**63 - 1, exclude=True)

    @model_validator(mode="after")
    def validate_references(self):
        ids = [word.id for word in self.words]
        id_set = set(ids)
        if len(ids) != len(id_set):
            raise ValueError("word IDs must be unique")
        if any(not WORD_ID_RE.fullmatch(item) or item not in id_set for item in self.shortenedGapIds):
            raise ValueError("shortened gaps must reference words in this project")
        if len(self.shortenedGapIds) != len(set(self.shortenedGapIds)):
            raise ValueError("shortened gap IDs must be unique")
        gap_edit_ids = [edit.afterWordId for edit in self.gapEdits]
        if any(item not in id_set for item in gap_edit_ids):
            raise ValueError("gap edits must reference words in this project")
        if len(gap_edit_ids) != len(set(gap_edit_ids)):
            raise ValueError("gap edits must have one target per word")
        for label, references in (
            ("cleanup keep word IDs", self.cleanupKeepWordIds),
            ("cleanup keep gap IDs", self.cleanupKeepGapIds),
        ):
            if any(not WORD_ID_RE.fullmatch(item) or item not in id_set for item in references):
                raise ValueError(f"{label} must reference words in this project")
            if len(references) != len(set(references)):
                raise ValueError(f"{label} must be unique")
        for group in self.collapsedRetakes:
            if any(not WORD_ID_RE.fullmatch(item) or item not in id_set for item in group):
                raise ValueError("retake groups must reference words in this project")
        retake_group_ids = [group.id for group in self.retakeGroups]
        if len(retake_group_ids) != len(set(retake_group_ids)):
            raise ValueError("durable retake group IDs must be unique")
        for group in self.retakeGroups:
            if any(
                not WORD_ID_RE.fullmatch(item) or item not in id_set
                for candidate in group.candidates
                for item in candidate
            ):
                raise ValueError("durable retake candidates must reference words in this project")
        insert_ids = [item.id for item in self.insertClips]
        if len(insert_ids) != len(set(insert_ids)):
            raise ValueError("insert IDs must be unique")
        if any(item.afterWordId is not None and item.afterWordId not in id_set for item in self.insertClips):
            raise ValueError("insert anchors must reference words in this project")
        if sum(item.duration for item in self.insertClips) > MAX_AUDIO_SECONDS:
            raise ValueError("total inserted audio exceeds the project limit")
        marker_ids = [marker.id for marker in self.markers]
        if len(marker_ids) != len(set(marker_ids)):
            raise ValueError("marker IDs must be unique")
        insert_by_id = {item.id: item for item in self.insertClips}
        for marker in self.markers:
            for anchor in (marker.anchor, marker.end):
                if anchor is None or anchor.insertId is None:
                    continue
                clip = insert_by_id.get(anchor.insertId)
                if clip is None:
                    raise ValueError("marker insert anchors must reference a declared insert")
                if anchor.insertOffset is None or anchor.insertOffset > clip.duration:
                    raise ValueError("marker insert offset must be inside its recorded take")
        speaker_ids = [speaker.id for speaker in self.speakers]
        if len(speaker_ids) != len(set(speaker_ids)):
            raise ValueError("speaker IDs must be unique")
        speaker_id_set = set(speaker_ids)
        for word_id, speaker_id in self.speakerByWord.items():
            if not WORD_ID_RE.fullmatch(word_id) or word_id not in id_set:
                raise ValueError("speaker assignments must reference words in this project")
            if speaker_id not in speaker_id_set:
                raise ValueError("speaker assignments must reference a declared speaker")
        starts = [word.startTime for word in self.words]
        if starts != sorted(starts):
            raise ValueError("word timestamps must be chronological")
        return self


SOURCE_TIME_TOLERANCE_SECONDS = 0.001


def project_source_duration(meta: Any) -> float | None:
    """Return a trustworthy persisted source duration, if this project has one.

    Older/in-progress projects can legitimately have no duration yet.  Those
    states retain the pre-existing global schema bounds until transcription has
    produced a finite duration in metadata.
    """
    if not isinstance(meta, dict):
        return None
    value = meta.get("duration")
    if isinstance(value, bool):
        return None
    try:
        duration = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(duration) or duration < 0:
        return None
    return duration


def validate_state_source_bounds(state: dict[str, Any], source_duration: float | None) -> None:
    """Keep persisted source references inside a project with known duration."""
    if source_duration is None:
        return
    limit = source_duration + SOURCE_TIME_TOLERANCE_SECONDS

    def require_source_time(value: Any, label: str) -> None:
        if isinstance(value, bool):
            raise HTTPException(400, f"{label} is not a finite source time")
        try:
            timestamp = float(value)
        except (TypeError, ValueError):
            raise HTTPException(400, f"{label} is not a finite source time") from None
        if not math.isfinite(timestamp) or timestamp < 0:
            raise HTTPException(400, f"{label} is not a finite source time")
        if timestamp > limit:
            raise HTTPException(400, f"{label} exceeds the source duration")

    for word in state.get("words", []):
        if not isinstance(word, dict):
            raise HTTPException(400, "word state is invalid")
        require_source_time(word.get("startTime"), "word start time")
        require_source_time(word.get("endTime"), "word end time")

    for marker in state.get("markers", []):
        if not isinstance(marker, dict):
            raise HTTPException(400, "marker state is invalid")
        for key in ("anchor", "end"):
            anchor = marker.get(key)
            if anchor is None:
                continue
            if not isinstance(anchor, dict):
                raise HTTPException(400, "marker anchor state is invalid")
            require_source_time(anchor.get("sourceTime"), "marker source anchor")


def validate_insert_assets(
    directory: Path,
    raw_clips: list[Any],
    words: list[WordState] | list[dict[str, Any]],
    source_duration: float | None,
) -> list[dict[str, Any]]:
    """Validate state references against immutable WAVs owned by this project."""
    if not isinstance(raw_clips, list) or len(raw_clips) > MAX_INSERT_CLIPS:
        raise HTTPException(400, "too many insert clips")
    try:
        clips = [InsertClipState.model_validate(item) for item in raw_clips]
    except ValidationError as exc:
        raise HTTPException(400, "insert clip state is invalid") from exc

    insert_ids = [item.id for item in clips]
    if len(insert_ids) != len(set(insert_ids)):
        raise HTTPException(400, "insert IDs must be unique")
    word_ids = {
        item.id if isinstance(item, WordState) else str(item.get("id", ""))
        for item in words
    }
    if any(item.afterWordId is not None and item.afterWordId not in word_ids for item in clips):
        raise HTTPException(400, "insert anchors must reference words in this project")

    try:
        source_duration = float(source_duration) if source_duration is not None else None
    except (TypeError, ValueError):
        source_duration = None
    if source_duration is None or not math.isfinite(source_duration) or source_duration < 0:
        source_duration = max(
            (
                float(item.endTime) if isinstance(item, WordState) else float(item.get("endTime", 0))
                for item in words
            ),
            default=0,
        )
    if any(item.sourceTime > source_duration + 0.001 for item in clips):
        raise HTTPException(400, "insert source time exceeds the source duration")

    from .render import wav_duration

    normalized: list[dict[str, Any]] = []
    total_duration = 0.0
    for item in clips:
        path = recording_file(directory, item.clipId)
        try:
            with wave.open(str(path), "rb") as handle:
                if handle.getnchannels() != 1 or handle.getframerate() != 48_000 or handle.getsampwidth() != 2:
                    raise HTTPException(400, f"recording clip {item.clipId} is not canonical")
        except (OSError, wave.Error) as exc:
            raise HTTPException(400, f"recording clip {item.clipId} is not a valid WAV") from exc
        actual_duration = wav_duration(str(path))
        if actual_duration is None or actual_duration <= 0:
            raise HTTPException(400, f"recording clip {item.clipId} is not a valid WAV")
        if actual_duration > MAX_RECORDING_SECONDS + 0.001:
            raise HTTPException(400, f"recording clip {item.clipId} exceeds the duration limit")
        if abs(actual_duration - item.duration) > 0.01:
            raise HTTPException(400, f"recording clip {item.clipId} duration does not match")
        total_duration += actual_duration
        value = item.model_dump()
        value["duration"] = actual_duration
        normalized.append(value)
    if total_duration > MAX_AUDIO_SECONDS + 0.001:
        raise HTTPException(400, "total inserted audio exceeds the project limit")
    return normalized


class ClientErrorPayload(BaseModel):
    """A deliberately small diagnostic envelope from the desktop webview."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    source: str = Field(default="unknown", max_length=64)
    name: str = Field(default="Error", max_length=120)
    message: str = Field(min_length=1, max_length=2_000)
    stack: str | None = Field(default=None, max_length=16_000)
    componentStack: str | None = Field(default=None, max_length=16_000)
    detail: str | None = Field(default=None, max_length=4_000)
    page: str | None = Field(default=None, max_length=2_048)
    occurredAt: str | None = Field(default=None, max_length=64)
    # Kept for compatibility with early diagnostic clients.
    location: str | None = Field(default=None, max_length=2_048)
    userAgent: str | None = Field(default=None, max_length=1_024)


def client_error_location(value: str | None) -> str | None:
    """Retain useful page context without persisting query tokens or fragments."""
    if not value:
        return None
    try:
        parsed = urlsplit(value)
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    except ValueError:
        return value.split("?", 1)[0].split("#", 1)[0]


def client_log_text(value: str | None) -> str | None:
    """Redact the desktop session token and token-shaped query values."""
    if not value:
        return None
    redacted = value
    session_token = os.environ.get("SCRIPTCUT_SESSION_TOKEN", "")
    if session_token:
        redacted = redacted.replace(session_token, "[redacted]")
    return re.sub(
        r"(?i)(\b(?:token|access_token|api_key|apikey)=)[^&#\s\"']+",
        r"\1[redacted]",
        redacted,
    )


@app.post("/api/client-errors")
def log_client_error(payload: ClientErrorPayload, request: Request):
    user_agent = payload.userAgent or request.headers.get("user-agent", "")
    logger.error(
        "Client error: source=%r name=%r message=%r detail=%r stack=%r "
        "component_stack=%r location=%r occurred_at=%r user_agent=%r",
        client_log_text(payload.source),
        client_log_text(payload.name),
        client_log_text(payload.message),
        client_log_text(payload.detail),
        client_log_text(payload.stack),
        client_log_text(payload.componentStack),
        client_log_text(client_error_location(payload.page or payload.location)),
        client_log_text(payload.occurredAt),
        client_log_text(user_agent[:1_024]),
    )
    return {"ok": True}


@app.get("/api/health")
def health():
    # Excludes project/media data. The launcher and support diagnostics can use
    # this to prove the bundled frontend/backend are from the same build.
    return {"ok": True, "service": "ScriptSurgeon", "build": build_identity()}


@app.post("/api/diagnostics/retake-analysis")
def log_retake_analysis(payload: RetakeDiagnosticPayload):
    """Record one private, correlation-friendly count summary for support."""
    logger.info(
        "retake_analysis correlation_id=%s project_id=%s media_asset_id=%s "
        "job_id=%s job_status=%s stage=%s revision=%s words=%s "
        "range=%.3f-%.3f source_duration=%.3f processed_duration=%.3f "
        "source_format=%sHz/%sch processed_format=%sHz/%sch "
        "candidate_windows=%s rejected=%s groups=%s suggestions=%s noise=%s "
        "exception_type=%s exception_location=%s",
        payload.correlationId,
        payload.projectId,
        payload.mediaAssetId,
        payload.jobId,
        payload.jobStatus,
        payload.stage,
        payload.transcriptRevision,
        payload.wordCount,
        payload.sourceStart,
        payload.sourceEnd,
        payload.sourceDuration,
        payload.processedDuration,
        payload.sourceSampleRate,
        payload.sourceChannels,
        payload.processedSampleRate,
        payload.processedChannels,
        payload.candidateWindows,
        json.dumps(payload.rejected, sort_keys=True, separators=(",", ":")),
        payload.groups,
        payload.suggestions,
        payload.noiseReduction,
        payload.exceptionType,
        payload.exceptionLocation,
    )
    return {"ok": True, "correlationId": payload.correlationId}


@app.post("/api/projects")
async def create_project(file: UploadFile = File(...), name: str | None = Form(None)):
    pid: str | None = None
    staging: Path | None = None
    size = 0
    published = False
    try:
        ext = source_extension(file)
        project_name = normalized_project_name(name, file.filename)
        pid = reserve_project_id()
        staging = creation_root() / uuid.uuid4().hex
        staging.mkdir()
        directory = _project_path(pid, require_exists=False)
        destination = staging / f"original{ext}"
        with destination.open("xb") as output:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"file exceeds the {MAX_UPLOAD_BYTES // 1024**3:g} GB limit")
                output.write(chunk)
        if size == 0:
            raise HTTPException(400, "the media file is empty")
        duration, sample_rate, channels = await run_in_threadpool(validate_media, destination)
        atomic_json(meta_path(staging), {
            "id": pid,
            "name": project_name,
            "duration": round(duration, 3) if duration is not None else None,
            "sampleRate": sample_rate,
            "channels": channels,
            "sourceBytes": size,
        })
        atomic_json(status_path(staging), {
            "status": "queued",
            "stage": "queued",
            "message": "Waiting for the local transcriber",
            "progress": 0,
            "error": None,
        })
        with project_lock(pid):
            if directory.exists():
                raise FileExistsError("project ID collision")
            staging.rename(directory)
            published = True
            enqueue_transcription(pid, directory / destination.name)
        return {"id": pid, "name": project_name}
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    finally:
        await file.close()
        if not published and staging is not None:
            remove_creation_stage(staging)
        if pid is not None:
            release_project_id(pid)


@app.post("/api/projects/{pid}/recordings")
async def create_recording(pid: str, file: UploadFile = File(...)):
    """Store one browser microphone take as an immutable canonical WAV."""
    ext = Path(file.filename or "").suffix.lower()
    media_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    if ext not in RECORDING_EXT and media_type not in RECORDING_MIME:
        raise HTTPException(400, "recording must be a supported audio file")

    directory = pdir(pid)
    upload_registered = False
    with project_lock(pid):
        if not state_path(directory).is_file():
            raise HTTPException(409, "transcription is not ready")
        storage = recordings_dir(directory, create=True)
        recording_uploads[pid] = recording_uploads.get(pid, 0) + 1
        upload_registered = True

    token = uuid.uuid4().hex
    raw_path = storage / f".upload-{token}{ext if ext in RECORDING_EXT else '.blob'}"
    canonical_path = storage / f".recording-{token}.tmp"
    size = 0
    try:
        with raw_path.open("xb") as output:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_RECORDING_BYTES:
                    raise HTTPException(
                        413,
                        f"recording exceeds the {MAX_RECORDING_BYTES // 1024**2:g} MiB limit",
                    )
                output.write(chunk)
        if size == 0:
            raise HTTPException(400, "the recording is empty")

        try:
            duration = await run_in_threadpool(canonicalize_recording, raw_path, canonical_path)
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(400, str(exc)) from exc

        with project_lock(pid):
            # The project may have been deleted while its upload was streaming
            # or decoding. Re-resolve it before publishing the immutable asset.
            directory = pdir(pid)
            if not state_path(directory).is_file():
                raise HTTPException(409, "transcription is not ready")
            storage = recordings_dir(directory, create=True)
            canonical_bytes = canonical_path.stat().st_size
            if recording_storage_bytes(directory) + canonical_bytes > MAX_RECORDING_STORAGE_BYTES:
                raise HTTPException(413, "recording storage for this project is full")
            while True:
                clip_id = uuid.uuid4().hex[:12]
                published = recording_file(directory, clip_id, require_exists=False)
                if not published.exists():
                    break
            os.replace(canonical_path, published)

        return {
            "clipId": clip_id,
            "duration": duration,
            "sampleRate": 48_000,
            "channels": 1,
        }
    finally:
        await file.close()
        for temporary in (raw_path, canonical_path):
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
        if upload_registered:
            with project_lock(pid):
                active = recording_uploads.get(pid, 0)
                if active <= 1:
                    recording_uploads.pop(pid, None)
                else:
                    recording_uploads[pid] = active - 1


@app.get("/api/projects")
def list_projects():
    projects = []
    root = PROJECTS_DIR.resolve()
    candidates: list[tuple[float, Path]] = []
    for candidate in PROJECTS_DIR.iterdir():
        if not PROJECT_ID_RE.fullmatch(candidate.name):
            continue
        try:
            if candidate.is_symlink():
                continue
            directory = candidate.resolve(strict=True)
            if directory.parent != root or directory.name != candidate.name or not directory.is_dir():
                continue
            candidates.append((directory.stat().st_mtime, directory))
        except OSError:
            continue
    for _, directory in sorted(candidates, key=lambda item: item[0], reverse=True):
        try:
            meta = read_json(meta_path(directory))
            status = get_status(directory.name)
            meta["status"] = status.get("status", "ready" if state_path(directory).exists() else "queued")
            projects.append(meta)
        except HTTPException as exc:
            if exc.status_code == 404:
                continue
            raise
        except FileNotFoundError:
            continue
        except (json.JSONDecodeError, OSError):
            projects.append({
                "id": directory.name,
                "name": "Damaged project",
                "duration": None,
                "sampleRate": None,
                "status": "error",
            })
    return projects


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    meta, state = load_project(pid)
    return {"meta": meta, "state": state, "status": get_status(pid)}


@app.get("/api/projects/{pid}/status")
def project_status(pid: str):
    directory = pdir(pid)
    status = get_status(pid)
    if not status:
        status = {"status": "ready" if state_path(directory).exists() else "queued"}
    return status


@app.post("/api/projects/{pid}/transcription/retry")
def retry_transcription(pid: str):
    """Requeue a terminal failed transcription without replacing its source."""
    directory = pdir(pid)
    with project_lock(pid):
        directory = pdir(pid)
        if state_path(directory).exists():
            raise HTTPException(409, "transcription is already complete")
        status = get_status(pid)
        if status.get("status") not in {"error", "cancelled"}:
            raise HTTPException(409, "transcription is not in a retryable state")
        # A worker writes its terminal status before removing this in-memory
        # marker. Do not lose a retry by racing that final cleanup window.
        with status_lock:
            if pid in queued_ids:
                raise HTTPException(409, "transcription is still finishing; try again")
        source = original_file(directory)
        enqueue_transcription(pid, source)
    return {"ok": True, "status": "queued"}


@app.put("/api/projects/{pid}/state")
def save_state(pid: str, payload: StatePayload):
    directory = pdir(pid)
    with project_lock(pid):
        current = read_json(state_path(directory)) if state_path(directory).exists() else {}
        metadata_file = meta_path(directory)
        try:
            meta = read_json(metadata_file) if metadata_file.exists() else {}
        except (json.JSONDecodeError, OSError) as exc:
            raise HTTPException(500, "project metadata is damaged") from exc
        source_duration = project_source_duration(meta)
        revision = int(current.get("revision", 0)) + 1
        state = payload.model_dump()
        # Legacy clients do not know about cleanup overrides. Preserve existing
        # values when a field was omitted, while allowing an explicit [] to
        # clear an override list.
        valid_ids = {word.id for word in payload.words}
        for field in ("cleanupKeepWordIds", "cleanupKeepGapIds"):
            if field not in payload.model_fields_set:
                state[field] = list(dict.fromkeys(
                    item for item in current.get(field, [])
                    if isinstance(item, str) and item in valid_ids
                ))
        # A new client sends exact per-gap targets. Older clients only know the
        # legacy ID list, so retain a current custom target when that ID remains
        # selected and use the established 300 ms target for a newly added ID.
        if "gapEdits" not in payload.model_fields_set:
            current_targets = {
                item.get("afterWordId"): item.get("targetGapMs", 300)
                for item in current.get("gapEdits", [])
                if isinstance(item, dict) and item.get("afterWordId") in valid_ids
            }
            state["gapEdits"] = [
                {"afterWordId": item, "targetGapMs": int(current_targets.get(item, 300))}
                for item in state.get("shortenedGapIds", [])
                if item in valid_ids
            ]
        state["shortenedGapIds"] = [item["afterWordId"] for item in state["gapEdits"]]
        if "gapPacing" not in payload.model_fields_set:
            current_pacing = current.get("gapPacing")
            state["gapPacing"] = current_pacing if isinstance(current_pacing, dict) else {
                "preset": "podcast",
                "detectionThresholdMs": 800,
                "targetGapMs": 300,
            }
        # Retake groups were added after the legacy collapsedRetakes projection.
        # Preserve them for older clients that cannot present alternate takes.
        if "retakeGroups" not in payload.model_fields_set:
            state["retakeGroups"] = current.get("retakeGroups", [])
        # An older frontend must not erase recorded inserts it does not know
        # how to display. Explicit [] remains the undoable "clear all" action.
        if "insertClips" not in payload.model_fields_set:
            state["insertClips"] = current.get("insertClips", [])
        if state.get("insertClips"):
            state["insertClips"] = validate_insert_assets(
                directory,
                state["insertClips"],
                payload.words,
                source_duration,
            )
        else:
            state["insertClips"] = []
        # Marker metadata is additive. Older clients must not erase it; if an
        # insert was explicitly removed, convert its marker to a source anchor
        # rather than leave a dangling reference in the project file.
        if "markers" not in payload.model_fields_set:
            state["markers"] = current.get("markers", [])
        insert_ids = {item.get("id") for item in state["insertClips"] if isinstance(item, dict)}
        for marker in state.get("markers", []):
            if not isinstance(marker, dict):
                continue
            for anchor_key in ("anchor", "end"):
                anchor = marker.get(anchor_key)
                if isinstance(anchor, dict) and anchor.get("insertId") not in insert_ids:
                    anchor.pop("insertId", None)
                    anchor.pop("insertOffset", None)
        validate_state_source_bounds(state, source_duration)
        state["revision"] = revision
        atomic_json(state_path(directory), state)
    return {"ok": True, "revision": revision}


def render_project(
    pid: str,
    studio: bool,
    noise: str = "off",
    expected_revision: int | None = None,
    lease: bool = False,
    normalize: bool = False,
) -> tuple[Path, dict[str, Any]]:
    from .render import render_edited

    directory = pdir(pid)
    with project_lock(pid):
        meta, state = load_project(pid)
        if not state:
            raise HTTPException(409, "transcription is not ready")
        revision = int(state.get("revision", 0))
        if expected_revision is not None and revision != expected_revision:
            raise HTTPException(409, "project changed before rendering; please try again")
        path = render_edited(
            str(original_file(directory)),
            state["words"],
            state.get("gapEdits", state.get("shortenedGapIds", [])),
            studio,
            str(directory),
            state.get("insertClips", []),
            noise,
            normalize,
        )
        rendered = Path(path)
        if lease:
            acquire_render_lease(rendered)
        prune_render_cache(directory, rendered)
        return rendered, meta


@app.post("/api/projects/{pid}/render")
def render(
    pid: str,
    studio: bool = False,
    noise: str = "off",
    normalize: bool = False,
    revision: int | None = None,
):
    from .render import normalized_noise, wav_duration

    level = normalized_noise(noise)
    path, _ = render_project(pid, studio, level, revision, normalize=normalize)
    duration = wav_duration(str(path))
    return {
        "ok": True,
        "duration": duration,
        "url": (
            f"/api/projects/{pid}/audio?studio={'1' if studio else '0'}"
            f"&noise={level}&normalize={'1' if normalize else '0'}&v={path.stem}"
        ),
    }


@app.get("/api/projects/{pid}/audio")
def audio(
    pid: str,
    edited: bool = True,
    studio: bool = False,
    noise: str = "off",
    normalize: bool = False,
    v: str | None = None,
):
    background = None
    if edited:
        if v is not None:
            if not re.fullmatch(r"render_[0-9a-f]{20}", v):
                raise HTTPException(404, "audio version not found")
            directory = pdir(pid)
            with project_lock(pid):
                path = directory / f"{v}.wav"
                if not path.is_file() or path.parent.resolve() != directory.resolve():
                    raise HTTPException(404, "audio version not found")
                acquire_render_lease(path)
                prune_render_cache(directory, path)
        else:
            path, _ = render_project(pid, studio, noise, lease=True, normalize=normalize)
        background = BackgroundTask(release_render_lease, path)
    else:
        directory = pdir(pid)
        with project_lock(pid):
            # Raw-source playback streams after this function returns. Lease it
            # just like an edited render so deletion cannot remove the file in
            # the middle of a response.
            directory = pdir(pid)
            path = original_file(directory)
            acquire_render_lease(path)
        background = BackgroundTask(release_render_lease, path)
    media_type = "audio/wav" if path.suffix.lower() == ".wav" else (mimetypes.guess_type(path.name)[0] or "application/octet-stream")
    return FileResponse(path, media_type=media_type, background=background)


@app.post("/api/projects/{pid}/export")
def export(
    pid: str,
    studio: bool = True,
    noise: str = "off",
    normalize: bool = False,
    audio_format: str = Query("wav", alias="format"),
    start: float | None = None,
    end: float | None = None,
    revision: int | None = None,
):
    from .render import export_segment, normalized_noise, wav_duration

    if audio_format not in ("wav", "mp3"):
        raise HTTPException(400, "unsupported export format")
    for label, value in (("start", start), ("end", end)):
        if value is not None and (not math.isfinite(value) or value < 0):
            raise HTTPException(400, f"export {label} must be a non-negative number")
    if start is not None and end is not None and end <= start:
        raise HTTPException(400, "export range must end after it starts")

    path, meta = render_project(pid, studio, normalized_noise(noise), revision, lease=True, normalize=normalize)
    safe_name = "".join(char for char in str(meta.get("name", "export")) if char.isalnum() or char in " _-").strip() or "export"

    ranged = start is not None or end is not None
    if ranged:
        # Clamp to the render so a stale client selection cannot request a
        # segment past the end and produce an empty file.
        duration = wav_duration(str(path)) or 0.0
        begin = min(max(0.0, start or 0.0), duration)
        finish = min(end, duration) if end is not None else duration
        if finish - begin < 0.01:
            release_render_lease(path)
            raise HTTPException(400, "the selected range is empty")
    else:
        begin, finish = 0.0, None

    suffix = "_clip" if ranged else "_edit"
    if audio_format == "wav" and not ranged:
        return FileResponse(
            path,
            media_type="audio/wav",
            filename=f"{safe_name}{suffix}.wav",
            background=BackgroundTask(release_render_lease, path),
        )

    # The encode is a throwaway sibling of the leased render, so the cached WAV
    # stays reusable and no export file accumulates in the project directory.
    encoded = path.parent / f".export-{uuid.uuid4().hex}.{audio_format}"
    try:
        export_segment(str(path), str(encoded), audio_format, begin, finish)
    except Exception:
        encoded.unlink(missing_ok=True)
        release_render_lease(path)
        raise HTTPException(500, "the export could not be encoded")

    def release_export() -> None:
        release_render_lease(path)
        encoded.unlink(missing_ok=True)

    return FileResponse(
        encoded,
        media_type="audio/mpeg" if audio_format == "mp3" else "audio/wav",
        filename=f"{safe_name}{suffix}.{audio_format}",
        background=BackgroundTask(release_export),
    )


def _clip_duration_resolver(directory: Path):
    """Resolve an inserted take's length without decoding the whole file."""
    from .render import recording_path, wav_duration

    def resolve(clip_id: str) -> int:
        try:
            seconds = wav_duration(str(recording_path(directory, clip_id)))
        except (ValueError, OSError):
            return 0
        return round((seconds or 0.0) * 1000)

    return resolve


def _project_timeline(pid: str):
    """Build the edit timeline for a project's saved state."""
    from .timeline import build_timeline

    directory = pdir(pid)
    meta, state = load_project(pid)
    if not state:
        raise HTTPException(409, "transcription is not ready")
    duration_ms = round(float(meta.get("duration") or 0.0) * 1000)
    timeline = build_timeline(
        state["words"],
        state.get("gapEdits", state.get("shortenedGapIds", [])),
        duration_ms,
        state.get("insertClips", []),
        _clip_duration_resolver(directory),
    )
    return timeline, meta, state, directory


@app.get("/api/integrations")
def list_integrations():
    """Every delivery target and whether this install may run it."""
    from . import integrations

    return {
        "targets": [
            {
                "id": target.id,
                "label": target.label,
                "summary": target.summary,
                "extension": target.extension,
                "requiresVideo": target.requires_video,
            }
            for target in integrations.targets()
            if target.available
        ]
    }


@app.post("/api/projects/{pid}/integrations/{target_id}")
def run_integration(pid: str, target_id: str):
    from . import integrations

    target = integrations.get(target_id)
    if target is None:
        raise HTTPException(404, "unknown export target")

    with project_lock(pid):
        timeline, meta, state, directory = _project_timeline(pid)
        source = original_file(directory)
        # Targets write into a scratch directory that is removed once the
        # response has been streamed, so a failed or abandoned export never
        # leaves a partial file inside the project.
        scratch = directory / f".integration-{uuid.uuid4().hex}"
        scratch.mkdir(parents=True, exist_ok=True)
        request = integrations.ExportRequest(
            timeline=timeline,
            words=state["words"],
            state=state,
            meta=meta,
            project_dir=directory,
            source_path=source,
            output_dir=scratch,
        )
        try:
            produced = target.run(request)
        except integrations.Unavailable as exc:
            shutil.rmtree(scratch, ignore_errors=True)
            raise HTTPException(409, str(exc))
        except Exception:
            shutil.rmtree(scratch, ignore_errors=True)
            logger.exception("integration %s failed", target_id)
            raise HTTPException(500, "the export could not be produced")

    safe_name = "".join(
        char for char in str(meta.get("name", "export")) if char.isalnum() or char in " _-"
    ).strip() or "export"
    return FileResponse(
        produced,
        media_type=target.media_type,
        filename=f"{safe_name}.{target.extension}",
        background=BackgroundTask(shutil.rmtree, scratch, True),
    )


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    directory = pdir(pid)
    with status_lock:
        cancel_event = cancel_events.setdefault(pid, threading.Event())
    cancel_event.set()
    with project_lock(pid):
        if recording_uploads.get(pid, 0) > 0:
            raise HTTPException(409, "a recording is still being imported; try again in a moment")
        with render_lease_lock:
            if any(Path(path).parent == directory and count > 0 for path, count in render_leases.items()):
                raise HTTPException(409, "project audio is still in use; try again in a moment")
        shutil.rmtree(directory)
    with status_lock:
        statuses.pop(pid, None)
        queued_ids.discard(pid)
        cancel_events.pop(pid, None)
    with project_locks_lock:
        project_locks.pop(pid, None)
    recording_uploads.pop(pid, None)
    return {"ok": True}


# Serve the production frontend last so API routes always win.
if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="static")
