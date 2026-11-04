"""Disk-backed storage for the user's preferred default engine and model.

Keeps `preferredProvider` and `preferredModel`
in a persistent JSON file on disk, resolved at startup and updated whenever the user
changes their choice or signs into an engine.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from app.core.config import settings
from app.desktop import profile

FILE_NAME = "engine-preference.json"


def preference_file_path() -> Path:
    desktop = profile.current()
    if desktop is not None:
        return desktop.data_dir / FILE_NAME
    if settings.SQLITE_PATH.strip():
        return Path(settings.SQLITE_PATH).expanduser().parent / FILE_NAME
    return Path.home() / ".open-dots" / FILE_NAME


def read_preference() -> dict[str, str | None]:
    path = preference_file_path()
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        if isinstance(data, dict):
            provider = data.get("provider")
            model = data.get("model")
            effort = data.get("effort")
            return {
                "provider": str(provider).strip() if provider else None,
                "model": str(model).strip() if model else None,
                "effort": str(effort).strip() if effort else None,
            }
    except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
        pass
    return {"provider": None, "model": None, "effort": None}


def write_preference(provider: str | None, model: str | None = None, effort: str | None = None) -> dict[str, str | None]:
    path = preference_file_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    clean_provider = provider.strip() if provider else None
    clean_model = model.strip() if model else None
    clean_effort = effort.strip() if effort else None
    data = {
        "version": 1,
        "provider": clean_provider,
        "model": clean_model,
        "effort": clean_effort,
        "updated_at": datetime.now(UTC).isoformat(),
    }
    temp_dir = path.parent
    fd, temp_path = tempfile.mkstemp(prefix=f".{FILE_NAME}.", dir=temp_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    finally:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
    return {"provider": clean_provider, "model": clean_model, "effort": clean_effort}

