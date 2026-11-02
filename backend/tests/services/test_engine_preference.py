import pytest
from app.services import engine_preference
from app.desktop import profile


def test_preference_file_roundtrip(tmp_path, monkeypatch):
    test_file = tmp_path / "engine-preference.json"
    monkeypatch.setattr(engine_preference, "preference_file_path", lambda: test_file)

    # Initial read when no file exists
    assert engine_preference.read_preference() == {"provider": None, "model": None, "effort": None}

    # Write preference
    saved = engine_preference.write_preference("antigravity", "gemini-2.5-pro", "high")
    assert saved == {"provider": "antigravity", "model": "gemini-2.5-pro", "effort": "high"}

    # Read back from disk
    assert engine_preference.read_preference() == {"provider": "antigravity", "model": "gemini-2.5-pro", "effort": "high"}

    # Update preference with no model (default)
    saved2 = engine_preference.write_preference("codex", None, None)
    assert saved2 == {"provider": "codex", "model": None, "effort": None}
    assert engine_preference.read_preference() == {"provider": "codex", "model": None, "effort": None}


def test_corrupt_file_handling(tmp_path, monkeypatch):
    test_file = tmp_path / "engine-preference.json"
    monkeypatch.setattr(engine_preference, "preference_file_path", lambda: test_file)

    test_file.write_text("not json content", encoding="utf-8")
    assert engine_preference.read_preference() == {"provider": None, "model": None, "effort": None}
