import asyncio
from collections.abc import Awaitable, Callable, Coroutine
from typing import Any, TypeVar

from app.core.logging import get_logger

logger = get_logger(__name__)

_T = TypeVar("_T")

# Fire-and-forget coroutines are kept here so they are not garbage-collected
# mid-flight: asyncio only holds a weak reference to a running task.
_detached: set[asyncio.Task[Any]] = set()


def spawn(coro: Coroutine[Any, Any, _T], *, name: str | None = None) -> asyncio.Task[_T]:
    """Run a coroutine in the background, holding a strong reference to the
    task until it finishes. Use this instead of a bare `asyncio.create_task`
    when nobody awaits the result."""
    task = asyncio.create_task(coro, name=name)
    _detached.add(task)
    task.add_done_callback(_detached.discard)
    return task


async def run_every(seconds: float, job: Callable[[], Awaitable[None]]) -> None:
    # Sleeps after each run finishes, so runs of the same job never overlap.
    while True:
        try:
            await job()
        except Exception:
            logger.exception("background job failed", job=job.__name__)
        await asyncio.sleep(seconds)
