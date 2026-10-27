"""One switch that stops this server from starting engine, tool or helper processes on its own host.

A hosted deployment signs many people in. Their agents must run in the user's own sandbox, never as
a process of this server, so the server sets HOST_EXECUTION_DISABLED and every place that would
start a process asks here first. The error is a PermissionError, so callers that already treat
"could not start" (an unreadable or missing program) as a normal failure handle it the same way.

This module must stay import-light: the computer tool server (computers/mcp_server.py) is a child
process with a minimal environment and imports docker_cli, which imports this. Loading the app
settings there would fail, so the settings are read only when the server already loaded them, and
the environment variable answers otherwise.
"""

import os
import sys


class HostExecutionDisabled(PermissionError):
    pass


def disabled() -> bool:
    config = sys.modules.get("app.core.config")
    if config is not None:
        return bool(config.settings.HOST_EXECUTION_DISABLED)
    return os.environ.get("HOST_EXECUTION_DISABLED", "").strip().lower() in {"1", "true", "yes", "on"}


def ensure_allowed(what: str) -> None:
    if disabled():
        raise HostExecutionDisabled(f"This server does not run {what} on its own machine.")
