"""Local Whisper speech-to-text service on CPU or GPU using faster-whisper."""

import importlib.util
import logging
import math
import os
import tempfile
import threading
from typing import Any

logger = logging.getLogger(__name__)

_MODEL_LOCK = threading.Lock()
_LOADED_MODEL: Any = None
_LOADED_MODEL_SIZE: str | None = None
_DEVICE_INFO_CACHE: tuple[str, str] | None = None


def is_available() -> bool:
    """Return True if faster-whisper is installed and importable."""
    return importlib.util.find_spec("faster_whisper") is not None


def get_device_info() -> tuple[str, str]:
    """Detect available hardware device and compute type.

    Returns (device, compute_type), e.g. ('cuda', 'float16') or ('cpu', 'int8').
    """
    global _DEVICE_INFO_CACHE
    if _DEVICE_INFO_CACHE is not None:
        return _DEVICE_INFO_CACHE
    if importlib.util.find_spec("ctranslate2") is not None:
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                _DEVICE_INFO_CACHE = ("cuda", "float16")
                return _DEVICE_INFO_CACHE
        except Exception:
            pass
    _DEVICE_INFO_CACHE = ("cpu", "int8")
    return _DEVICE_INFO_CACHE


def get_model(model_size: str = "tiny"):
    """Get or lazily initialize the singleton WhisperModel."""
    global _LOADED_MODEL, _LOADED_MODEL_SIZE
    with _MODEL_LOCK:
        if _LOADED_MODEL is not None and _LOADED_MODEL_SIZE == model_size:
            return _LOADED_MODEL

        from faster_whisper import WhisperModel

        device, compute_type = get_device_info()
        logger.info(
            "Loading local Whisper model '%s' on device '%s' (%s)",
            model_size,
            device,
            compute_type,
        )
        _LOADED_MODEL = WhisperModel(model_size, device=device, compute_type=compute_type)
        _LOADED_MODEL_SIZE = model_size
        return _LOADED_MODEL


def transcribe_file(file_path: str, model_size: str = "tiny", language: str | None = None) -> dict[str, Any]:
    """Transcribe an audio file using local Whisper.

    Returns standard transcription result dict matching Open Duet schema.
    """
    model = get_model(model_size)
    segments_gen, info = model.transcribe(file_path, language=language, beam_size=1)

    segments = []
    text_parts = []
    for i, seg in enumerate(segments_gen, 1):
        clean_text = seg.text.strip()
        if clean_text:
            text_parts.append(clean_text)
            segments.append({
                "id": i,
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": clean_text,
            })

    full_text = " ".join(text_parts).strip()
    duration = round(info.duration, 2) if (info.duration and math.isfinite(info.duration)) else 0.0

    device, _ = get_device_info()
    return {
        "text": full_text,
        "segments": segments,
        "duration_seconds": duration,
        "language": info.language,
        "language_probability": round(info.language_probability, 3) if info.language_probability else 1.0,
        "provider": "local",
        "model": f"whisper-{model_size}",
        "device": device,
        "complete": True,
    }


def transcribe_bytes(data: bytes, filename: str = "recording.wav", model_size: str = "tiny", language: str | None = None) -> dict[str, Any]:
    """Transcribe in-memory audio bytes by writing to a temporary file."""
    ext = os.path.splitext(filename)[1].lower() or ".wav"
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        return transcribe_file(tmp_path, model_size=model_size, language=language)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass

