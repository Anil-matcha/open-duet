"""Disk-backed storage for user profile information (display name, avatar, bio).

Follows OpenBot's profile store pattern: persists `name` and `avatar_url` in a JSON
file on disk in the desktop profile / user data directory, with atomic writes.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.desktop import profile

FILE_NAME = "user-profile.json"


def profile_file_path() -> Path:
    desktop = profile.current()
    if desktop is not None:
        return desktop.data_dir / FILE_NAME
    if settings.SQLITE_PATH.strip():
        return Path(settings.SQLITE_PATH).expanduser().parent / FILE_NAME
    return Path.home() / ".open-dots" / FILE_NAME


def detect_system_identity() -> tuple[str | None, str | None]:
    """Detect local developer identity from git config or system environment.
    Never hardcoded: purely reads local git config or OS environment."""
    name: str | None = None
    email: str | None = None

    # 1. Try local git configuration
    try:
        import subprocess
        git_name = subprocess.check_output(
            ["git", "config", "user.name"], text=True, stderr=subprocess.DEVNULL
        ).strip()
        if git_name:
            name = git_name
    except Exception:
        pass

    try:
        import subprocess
        git_email = subprocess.check_output(
            ["git", "config", "user.email"], text=True, stderr=subprocess.DEVNULL
        ).strip()
        if git_email and "@" in git_email:
            email = git_email
    except Exception:
        pass

    # 2. If email exists but no name, derive name from email prefix
    if email and not name:
        name = email.split("@")[0]

    # 3. Fallback to OS user
    if not name:
        name = os.environ.get("USERNAME") or os.environ.get("USER")

    return name, email


def read_profile() -> dict[str, Any]:
    path = profile_file_path()
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        if isinstance(data, dict):
            saved_name = str(data.get("name") or "").strip() or None
            saved_avatar = str(data.get("avatar_url") or "").strip() or None
            saved_bio = str(data.get("bio") or "").strip() or None
            if saved_name or saved_avatar or saved_bio:
                return {
                    "name": saved_name,
                    "avatar_url": saved_avatar,
                    "bio": saved_bio,
                    "updated_at": data.get("updated_at"),
                }
    except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
        pass

    # Fallback to auto-detected local identity
    detected_name, _ = detect_system_identity()
    return {"name": detected_name, "avatar_url": None, "bio": None, "updated_at": None}


def write_profile(
    name: str | None = None,
    avatar_url: str | None = None,
    bio: str | None = None,
) -> dict[str, Any]:
    path = profile_file_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    clean_name = str(name).strip() if name and str(name).strip() else None
    clean_avatar = str(avatar_url).strip() if avatar_url and str(avatar_url).strip() else None
    clean_bio = str(bio).strip() if bio and str(bio).strip() else None

    # Merge with existing so partial updates don't wipe out other fields
    existing = read_profile()
    updated_name = clean_name if name is not None else existing.get("name")
    updated_avatar = clean_avatar if avatar_url is not None else existing.get("avatar_url")
    updated_bio = clean_bio if bio is not None else existing.get("bio")

    now_iso = datetime.now(UTC).isoformat()
    data = {
        "version": 1,
        "name": updated_name,
        "avatar_url": updated_avatar,
        "bio": updated_bio,
        "updated_at": now_iso,
    }

    temp_dir = path.parent
    fd, temp_path = tempfile.mkstemp(prefix=f".{FILE_NAME}.", dir=temp_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
        os.replace(temp_path, path)
    except Exception:
        try:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
        except OSError:
            pass
        raise

    return {
        "name": updated_name,
        "avatar_url": updated_avatar,
        "bio": updated_bio,
        "updated_at": now_iso,
    }

