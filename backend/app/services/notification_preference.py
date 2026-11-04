"""Disk-backed storage for user notification preferences (BL-83).

Stores whether desktop OS notifications are enabled, and which categories
of events trigger notifications (needs_you / approvals, routine failures,
task reminders, sound).
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from app.core.config import settings
from app.desktop import profile

FILE_NAME = "notification-preference.json"


@dataclass
class NotificationPreferences:
    desktop_enabled: bool = True
    notify_needs_you: bool = True
    notify_failures: bool = True
    notify_task_due: bool = True
    notify_turn_completed: bool = True
    sound_enabled: bool = False
    quiet_hours_enabled: bool = False
    quiet_hours_start: str = "22:00"
    quiet_hours_end: str = "08:00"

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def preference_file_path() -> Path:
    desktop = profile.current()
    if desktop is not None:
        return desktop.data_dir / FILE_NAME
    if settings.SQLITE_PATH.strip():
        return Path(settings.SQLITE_PATH).expanduser().parent / FILE_NAME
    return Path.home() / ".open-dots" / FILE_NAME


def read_preferences() -> NotificationPreferences:
    path = preference_file_path()
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        if isinstance(data, dict):
            return NotificationPreferences(
                desktop_enabled=bool(data.get("desktop_enabled", True)),
                notify_needs_you=bool(data.get("notify_needs_you", True)),
                notify_failures=bool(data.get("notify_failures", True)),
                notify_task_due=bool(data.get("notify_task_due", True)),
                notify_turn_completed=bool(data.get("notify_turn_completed", True)),
                sound_enabled=bool(data.get("sound_enabled", False)),
                quiet_hours_enabled=bool(data.get("quiet_hours_enabled", False)),
                quiet_hours_start=str(data.get("quiet_hours_start", "22:00")),
                quiet_hours_end=str(data.get("quiet_hours_end", "08:00")),
            )
    except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
        pass
    return NotificationPreferences()


def write_preferences(prefs: NotificationPreferences) -> NotificationPreferences:
    path = preference_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(prefs.to_dict(), indent=2), encoding="utf-8")
    tmp_path.replace(path)
    return prefs
