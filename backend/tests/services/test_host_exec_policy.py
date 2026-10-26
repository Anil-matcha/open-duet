"""Hosted accounts reach the agent routes only while the server refuses to run host processes."""

import asyncio

import pytest
from starlette.requests import Request

from app.auth.policy import Principal
from app.core import host_exec
from app.core.config import settings
from app.services import cli_probe
from app.services.local_access_policy import LocalAccessDenied, LoopbackPolicy


def request_for(principal: Principal) -> Request:
    scope = {"type": "http", "method": "GET", "path": "/", "headers": [(b"host", b"dots.example.com")],
             "client": ("203.0.113.7", 1), "state": {"auth": principal}}
    return Request(scope)


ACCOUNT = Principal(kind="account", tenant_id="u_" + "a" * 32)


@pytest.fixture(autouse=True)
def execution_on(monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)


def test_account_is_refused_while_host_execution_is_allowed(monkeypatch):
    monkeypatch.setattr(settings, "HOST_EXECUTION_DISABLED", False)
    with pytest.raises(LocalAccessDenied):
        LoopbackPolicy().authorize(request_for(ACCOUNT))


def test_account_is_granted_once_the_server_runs_nothing_itself(monkeypatch):
    monkeypatch.setattr(settings, "HOST_EXECUTION_DISABLED", True)
    LoopbackPolicy().authorize(request_for(ACCOUNT))


def test_remote_non_account_callers_stay_refused(monkeypatch):
    monkeypatch.setattr(settings, "HOST_EXECUTION_DISABLED", True)
    with pytest.raises(LocalAccessDenied):
        LoopbackPolicy().authorize(request_for(Principal(kind="loopback")))


def test_every_process_start_is_refused_when_switched_off(monkeypatch):
    monkeypatch.setattr(settings, "HOST_EXECUTION_DISABLED", True)
    with pytest.raises(PermissionError):
        host_exec.ensure_allowed("anything")
    result = asyncio.run(cli_probe.run(["true"], timeout=2))
    assert result.failed_to_start
