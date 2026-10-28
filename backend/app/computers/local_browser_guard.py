"""Limits for the browser on this machine, so Chromium cannot starve the app on a small sandbox.

Measured on a `small` sandbox (4 GB): a browser costs about 0.3 GB idle and 0.1 to 0.4 GB a tab.
The limits are therefore a browser cap, a tab cap, an idle close, a refusal when memory is low,
and an OOM score that makes Chromium the first thing the kernel ends.

Everything that reads the machine takes its source as a parameter, so it is testable anywhere.
Standard library only: the browser tool server that uses it is a child process.
"""

import json
import os
import signal
import time
from dataclasses import dataclass
from pathlib import Path

SIZE_ENV = "OPEN_DOTS_SANDBOX_SIZE"
STRICT_SIZES = frozenset({"", "small"})  # a missing size gets the stricter caps; any other named size gets the larger ones
LOW_BYTES = 512 * 1024 * 1024
LOW_FRACTION = 0.12
HOSTED_IDLE_SECONDS = 180
OOM_SCORE = 800  # Chromium is ended before the app (default 0) when memory runs out
LOW_MEMORY = "This machine is low on memory, so the browser will not open another page now. Close a tab or try again shortly."
LIMIT_TABS = "This machine allows at most {n} browser tabs. Close one first."


@dataclass(frozen=True)
class Limits:
    browsers: int
    tabs: int
    idle_seconds: int | None  # None: leave the broker's own default


def limits(size: str | None = None, *, hosted: bool = False) -> Limits:
    size = (os.environ.get(SIZE_ENV, "") if size is None else size).strip().lower()
    strict = size in STRICT_SIZES
    return Limits(1 if strict else 4, 4 if strict else 8, HOSTED_IDLE_SECONDS if hosted else None)


def memory_state(cgroup: Path = Path("/sys/fs/cgroup"), meminfo: Path = Path("/proc/meminfo")) -> tuple[int, int] | None:
    """(available, total) bytes: the cgroup's limit when it has one, else the machine's. None when unreadable."""
    try:
        limit = (cgroup / "memory.max").read_text().strip()
        if limit.isdigit():
            used = int((cgroup / "memory.current").read_text().strip())
            return max(int(limit) - used, 0), int(limit)
    except (OSError, ValueError):
        pass
    try:
        fields = {}
        for line in meminfo.read_text().splitlines():
            key, _, rest = line.partition(":")
            fields[key] = int(rest.split()[0]) * 1024
        return fields["MemAvailable"], fields["MemTotal"]
    except (OSError, ValueError, KeyError, IndexError):
        return None


def memory_low(state: tuple[int, int] | None) -> bool:
    """Under 512 MB or 12% available. Unknown memory is not treated as low."""
    if state is None:
        return False
    available, total = state
    return available < LOW_BYTES or (total > 0 and available < total * LOW_FRACTION)


def check_tabs(tabs: int, allowed: int) -> str | None:
    return LIMIT_TABS.format(n=allowed) if tabs >= allowed else None


def opens_page(name: str, args: dict) -> bool:
    """Whether a tool call can add a page: a navigation or a new tab."""
    return name == "browser_open" or (name == "browser_tabs" and args.get("action") == "new")


def protect_app(pid: int, score: int = OOM_SCORE, proc: Path = Path("/proc")) -> bool:
    """Raise a child's OOM score so it is chosen before the app. Linux only; False elsewhere or on refusal."""
    try:
        (proc / str(pid) / "oom_score_adj").write_text(str(score))
        return True
    except OSError:
        return False


# -- running browsers across tool-server processes --------------------------------------
# One small file per running browser in a shared folder: who, which broker group, last use.

def register(registry: Path, agent: str, pid: int, state_dir: Path, now: float | None = None) -> None:
    registry.mkdir(parents=True, exist_ok=True, mode=0o700)
    touch(registry, agent, pid, state_dir, now)


def touch(registry: Path, agent: str, pid: int, state_dir: Path, now: float | None = None) -> None:
    record = {"pid": pid, "state": str(state_dir), "used": time.time() if now is None else now}
    tmp = registry / f".{agent}.{os.getpid()}"
    tmp.write_text(json.dumps(record))
    os.replace(tmp, registry / f"{agent}.json")


def unregister(registry: Path, agent: str) -> None:
    (registry / f"{agent}.json").unlink(missing_ok=True)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def running(registry: Path) -> dict[str, dict]:
    """Live entries by agent; entries whose broker is gone are dropped."""
    found: dict[str, dict] = {}
    for path in registry.glob("*.json"):
        try:
            record = json.loads(path.read_text())
            pid = int(record["pid"])
        except (OSError, ValueError, KeyError, TypeError):
            path.unlink(missing_ok=True)
            continue
        if _alive(pid):
            found[path.stem] = record
        else:
            path.unlink(missing_ok=True)
    return found


def make_room(registry: Path, agent: str, cap: int, *, held=lambda state: False, kill=None, now: float | None = None) -> str | None:
    """Make space for `agent` to start a browser. Ends the least recently used idle, unwatched browser of
    another agent while the cap is reached. Returns a plain refusal when none can be ended, else None."""
    kill = kill or _kill_group
    now = time.time() if now is None else now
    while True:
        others = {a: r for a, r in running(registry).items() if a != agent}
        if len(others) + 1 <= cap:
            return None
        candidates = [(r["used"], a, r) for a, r in others.items() if not held(Path(r["state"]))]
        if not candidates:
            return f"This machine runs at most {cap} browser{'s' if cap != 1 else ''} at a time and the other is being watched. Try again shortly."
        _, victim, record = min(candidates, key=lambda item: item[0])
        kill(int(record["pid"]))
        unregister(registry, victim)


def _kill_group(pid: int) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except (ProcessLookupError, PermissionError, OSError):
            return
        time.sleep(.2)
