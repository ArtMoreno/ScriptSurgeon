"""Local transcription via faster-whisper with word-level timestamps."""
from __future__ import annotations

import os
import ctypes
import math
import threading
import uuid
from pathlib import Path
from typing import Callable

MODEL_SIZE = os.environ.get("MODEL_SIZE", "base")
MODEL_PATH = os.environ.get("SCRIPTCUT_MODEL_PATH", "")
MODEL_CACHE = os.environ.get("SCRIPTCUT_MODEL_CACHE", "")

_model = None
_model_lock = threading.Lock()
_device = "cpu"


def _model_source() -> str:
    if MODEL_PATH and Path(MODEL_PATH).is_dir():
        return MODEL_PATH
    return MODEL_SIZE


def _cuda_runtime_available() -> bool:
    mode = os.environ.get("SCRIPTCUT_CUDA", "auto").lower()
    if mode in {"0", "false", "off", "cpu"}:
        return False
    if os.name == "nt":
        try:
            ctypes.WinDLL("cublas64_12.dll")
            ctypes.WinDLL("cudnn64_9.dll")
        except OSError:
            return False
    return True


def _load_cpu_model():
    from faster_whisper import WhisperModel

    source = _model_source()
    kwargs = {"download_root": MODEL_CACHE} if MODEL_CACHE and not Path(source).is_dir() else {}
    return WhisperModel(source, device="cpu", compute_type="int8", **kwargs)


def get_model():
    """Load once, preferring CUDA only when a real model load succeeds."""
    global _model, _device
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        import ctranslate2
        from faster_whisper import WhisperModel

        source = _model_source()
        kwargs = {"download_root": MODEL_CACHE} if MODEL_CACHE and not Path(source).is_dir() else {}
        if _cuda_runtime_available() and ctranslate2.get_cuda_device_count() > 0:
            try:
                _model = WhisperModel(source, device="cuda", compute_type="float16", **kwargs)
                _device = "cuda"
                return _model
            except Exception:
                # CUDA runtimes are often absent even when an NVIDIA GPU is visible.
                _model = None
        _model = _load_cpu_model()
        _device = "cpu"
        return _model


def source_sample_rate(audio_path: str) -> int | None:
    try:
        import av

        with av.open(audio_path) as container:
            stream = next((item for item in container.streams if item.type == "audio"), None)
            rate = getattr(stream.codec_context, "sample_rate", None) if stream else None
            return int(rate) if rate else None
    except Exception:
        return None


def transcribe_words(audio_path: str, progress_cb: Callable[[float], None] | None = None):
    """Return words, source duration, and the real source sample rate."""
    global _model, _device
    model = get_model()
    options = {
        "word_timestamps": True,
        "vad_filter": True,
        "vad_parameters": {"min_silence_duration_ms": 400},
    }
    try:
        segments, info = model.transcribe(audio_path, **options)
    except RuntimeError as exc:
        # Some systems expose an NVIDIA device but not the matching cuBLAS/cuDNN
        # runtime. Retry once on CPU instead of failing the user's first import.
        message = str(exc).lower()
        if _device != "cuda" or not any(name in message for name in ("cuda", "cublas", "cudnn")):
            raise
        with _model_lock:
            _model = _load_cpu_model()
            _device = "cpu"
            model = _model
        segments, info = model.transcribe(audio_path, **options)
    words = []
    total = max(float(info.duration), 0.001)
    for segment in segments:
        for item in segment.words or []:
            text = item.word.strip()
            if not text:
                continue
            word = {
                "id": uuid.uuid4().hex[:10],
                "text": text,
                "startTime": round(float(item.start), 3),
                "endTime": round(float(item.end), 3),
                "isFiller": False,
                "isRetake": False,
                "isRemoved": False,
                "gapAfter": 0.0,
            }
            # faster-whisper versions differ: retain a bounded per-word
            # probability only when the local runtime exposes one. This is
            # review evidence, not a VAD/speech-probability signal.
            probability = getattr(item, "probability", None)
            try:
                probability = float(probability)
            except (TypeError, ValueError):
                probability = None
            if probability is not None and math.isfinite(probability):
                word["asrConfidence"] = round(min(1.0, max(0.0, probability)), 4)
            words.append(word)
        if progress_cb:
            progress_cb(min(max(float(segment.end) / total, 0.02), 0.99))
    for index in range(len(words) - 1):
        words[index]["gapAfter"] = round(max(0.0, words[index + 1]["startTime"] - words[index]["endTime"]), 3)
    return words, round(float(info.duration), 3), source_sample_rate(audio_path)
