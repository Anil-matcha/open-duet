"""One switch that stops this server from starting engine, tool or helper processes on its own host.

A hosted deployment signs many people in. Their agents must run in the user's own sandbox, never as
a process of this server, so the server sets HOST_EXECUTION_DISABLED and every place that would
start a process asks here first. The error is a PermissionError, so callers that already treat
"could not start" (an unreadable or missing program) as a normal failure handle it the same way.
"""

from app.core.config import settings


class HostExecutionDisabled(PermissionError):
    pass


def ensure_allowed(what: str) -> None:
    if settings.HOST_EXECUTION_DISABLED:
        raise HostExecutionDisabled(f"This server does not run {what} on its own machine.")
