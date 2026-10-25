"""The Boat auth flow builds shell commands run inside the sandbox. These
tests pin the boundary: untrusted `box_id` and `code` values can never reach
the shell as syntax (audit finding H-1)."""

import pytest
from pydantic import ValidationError

from app.schemas.sandbox import AuthLoginSubmitRequest
from app.services import auth_flow_service
from app.services.auth_flow_service import InvalidAuthInputError

INJECTIONS = [
    'x"; id > /tmp/pwned; #',
    "x'; touch /tmp/pwned; #",
    "x$(id)",
    "x`id`",
    "x\nid",
    "x && id",
    'x"; tmux kill-server; #',
]


@pytest.mark.parametrize("code", INJECTIONS)
def test_the_code_schema_refuses_shell_metacharacters(code):
    with pytest.raises(ValidationError):
        AuthLoginSubmitRequest(code=code)


@pytest.mark.parametrize("code", ["abc123", "a-b_c.d~e+f/g=h", "A1B2-C3"])
def test_the_code_schema_accepts_real_looking_codes(code):
    assert AuthLoginSubmitRequest(code=code).code == code


@pytest.mark.parametrize("box_id", INJECTIONS + ["", "a" * 65, "a b"])
def test_a_bad_box_id_is_refused_before_any_command(box_id):
    with pytest.raises(InvalidAuthInputError):
        auth_flow_service.submit_code(box_id, "claude", "abc123")


@pytest.mark.parametrize("box_id", INJECTIONS + ["", "a" * 65, "a b"])
def test_a_bad_box_id_is_refused_when_starting_a_login(box_id):
    with pytest.raises(InvalidAuthInputError):
        auth_flow_service.start_login(box_id, "claude")


def test_an_unknown_provider_is_refused_and_never_reaches_a_shell(monkeypatch):
    calls = []
    monkeypatch.setattr(
        auth_flow_service, "_run", lambda box_id, command: calls.append(command)
    )
    with pytest.raises(auth_flow_service.UnsupportedProviderError):
        auth_flow_service.submit_code("bx_ok", "not-a-provider", "abc123")
    assert calls == []


def test_the_submitted_code_is_sent_literally_not_spliced_into_shell(monkeypatch):
    """Even a code that passed validation is passed with `send-keys -l`, so it
    is never re-read as shell syntax or as a tmux key name."""
    commands = []

    def fake_run(box_id, command):
        commands.append(command)
        # First call is send-keys; the poll then never sees DONE, so a timeout
        # ends the function after we have captured what we need.
        return ""

    monkeypatch.setattr(auth_flow_service, "_ensure_box_running", lambda box_id: None)
    monkeypatch.setattr(auth_flow_service, "_run", fake_run)

    with pytest.raises(auth_flow_service.LoginTimeoutError):
        auth_flow_service.submit_code("bx_ok", "claude", "abc-123")

    send = commands[0]
    # The code is an argument to `send-keys -l --`, never spliced into shell
    # syntax: the shell sees exactly the words tmux, send-keys, -l, --, <code>.
    shell_word = __import__("shlex").quote("abc-123")
    assert send == (
        f"tmux send-keys -t auth_claude_bx_ok -l -- {shell_word}; "
        "tmux send-keys -t auth_claude_bx_ok Enter"
    )
