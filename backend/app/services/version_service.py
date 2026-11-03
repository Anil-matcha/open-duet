"""Version and update detection for Open Duet (BL-64).

Detects current version, git commit, installation mode (Docker, service/systemd,
git checkout, or source), checks GitHub releases for newer versions, and formats
the exact update command for the current setup.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Mapping

import httpx

APP_VERSION = "0.8.1"
RELEASES_URL = "https://api.github.com/repos/Anil-matcha/open-duet/releases?per_page=10"
CACHE_TTL_SECONDS = 3600  # 1 hour in-memory cache

SEMVER_REGEX = re.compile(
    r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"
)


def parse_version(text: str | None) -> tuple[tuple[int, int, int], list[str]] | None:
    match = SEMVER_REGEX.match(str(text or "").strip())
    if not match:
        return None
    core = (int(match.group(1)), int(match.group(2)), int(match.group(3)))
    pre = match.group(4).split(".") if match.group(4) else []
    return (core, pre)


def compare_versions(a: str, b: str) -> int:
    """Returns -1 if a < b, 0 if a == b, 1 if a > b."""
    left = parse_version(a)
    right = parse_version(b)
    if not left or not right:
        return 0
    if left[0] != right[0]:
        return -1 if left[0] < right[0] else 1
    if not left[1] and right[1]:
        return 1
    if left[1] and not right[1]:
        return -1
    for x, y in zip(left[1], right[1]):
        if x != y:
            if x.isdigit() and y.isdigit():
                return -1 if int(x) < int(y) else 1
            if x.isdigit() != y.isdigit():
                return -1 if x.isdigit() else 1
            return -1 if x < y else 1
    if len(left[1]) != len(right[1]):
        return -1 if len(left[1]) < len(right[1]) else 1
    return 0


def find_project_root() -> Path | None:
    """Finds the root repository folder by checking ancestors for .git or compose.yaml."""
    current = Path(__file__).resolve().parent
    for parent in [current, *current.parents]:
        if (parent / ".git").exists() or (parent / "compose.yaml").exists():
            return parent
    return None


def get_git_commit(root: Path | None = None) -> str | None:
    """Reads current git commit short SHA from .git without subprocesses."""
    project_root = root or find_project_root()
    if not project_root:
        return None

    git_dir = project_root / ".git"
    if not git_dir.exists():
        return None

    try:
        # If .git is a gitdir file (submodule / worktree)
        if git_dir.is_file():
            content = git_dir.read_text(encoding="utf-8").strip()
            if content.startswith("gitdir:"):
                git_dir = (project_root / content.split(":", 1)[1].strip()).resolve()

        head_file = git_dir / "HEAD"
        if not head_file.exists():
            return None

        head_content = head_file.read_text(encoding="utf-8").strip()
        if head_content.startswith("ref:"):
            ref_path = head_content[4:].strip()
            target_ref = git_dir / ref_path
            if target_ref.exists():
                return target_ref.read_text(encoding="utf-8").strip()[:7]

            # Check packed-refs
            packed_file = git_dir / "packed-refs"
            if packed_file.exists():
                for line in packed_file.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line and not line.startswith("#") and not line.startswith("^"):
                        parts = line.split(" ", 1)
                        if len(parts) == 2 and parts[1] == ref_path:
                            return parts[0][:7]
        else:
            return head_content[:7]
    except Exception:
        pass
    return None


def detect_install_kind(environ: Mapping[str, str] | None = None) -> str:
    """Detects whether Open Duet is running via Docker, systemd service, git checkout, or source."""
    env = os.environ if environ is None else environ
    if (
        env.get("OPEN_DOTS_DOCKER")
        or os.path.exists("/.dockerenv")
        or env.get("DOCKER_CONTAINER")
    ):
        return "docker"
    if env.get("OPEN_DOTS_SERVICE") or env.get("INVOCATION_ID"):
        return "service"

    root = find_project_root()
    if root and (root / ".git").exists():
        return "git"

    return "source"


def get_update_command(install_kind: str) -> str:
    """Returns the recommended update command for the detected deployment type."""
    if install_kind == "docker":
        return "git pull && docker compose build && docker compose up -d"
    elif install_kind == "service":
        return "git pull && uv sync && (cd frontend && npm run build) && sudo systemctl restart open-dots"
    elif install_kind == "git":
        return "git pull && uv sync && (cd frontend && npm run build)"
    return "git pull && uv sync && (cd frontend && npm run build)"


@dataclass
class VersionInfo:
    current_version: str
    commit: str | None
    latest_version: str | None
    update_available: bool
    install_kind: str
    update_command: str
    release_notes_url: str

    def to_dict(self) -> dict:
        return asdict(self)


_cache: dict[str, object] | None = None


async def fetch_latest_release(
    client: httpx.AsyncClient | None = None,
) -> tuple[str | None, str | None]:
    """Fetches the latest release tag and HTML url from GitHub."""
    close_client = False
    if client is None:
        client = httpx.AsyncClient(timeout=4.0)
        close_client = True

    try:
        resp = await client.get(
            RELEASES_URL,
            headers={
                "User-Agent": "open-duet-version-checker",
                "Accept": "application/vnd.github.v3+json",
            },
        )
        if resp.status_code == 200:
            releases = resp.json()
            if isinstance(releases, list):
                best_tag = None
                best_url = None
                for r in releases:
                    if not isinstance(r, dict) or r.get("draft"):
                        continue
                    tag = r.get("tag_name")
                    if not tag or not parse_version(tag):
                        continue
                    if best_tag is None or compare_versions(tag, best_tag) > 0:
                        best_tag = tag
                        best_url = r.get("html_url")
                if best_tag:
                    cleaned_tag = best_tag.lstrip("v")
                    return cleaned_tag, best_url
    except Exception:
        pass
    finally:
        if close_client:
            await client.aclose()

    return None, None


async def get_version_info(
    force_refresh: bool = False,
    client: httpx.AsyncClient | None = None,
    environ: Mapping[str, str] | None = None,
) -> VersionInfo:
    """Returns current version, update status, and command, cached for 1 hour."""
    global _cache

    now = time.time()
    if (
        not force_refresh
        and _cache is not None
        and (now - float(_cache["timestamp"])) < CACHE_TTL_SECONDS
    ):
        cached_info = _cache["data"]
        if isinstance(cached_info, VersionInfo):
            return cached_info

    install_kind = detect_install_kind(environ)
    commit = get_git_commit()
    update_command = get_update_command(install_kind)

    latest_tag, release_url = await fetch_latest_release(client)

    if latest_tag:
        update_available = compare_versions(latest_tag, APP_VERSION) > 0
        latest_version = latest_tag
        notes_url = (
            release_url
            or f"https://github.com/Anil-matcha/open-duet/releases/tag/v{latest_tag}"
        )
    else:
        # If GitHub is unreachable, fallback safely
        latest_version = None
        update_available = False
        notes_url = "https://github.com/Anil-matcha/open-duet/releases"

    info = VersionInfo(
        current_version=APP_VERSION,
        commit=commit,
        latest_version=latest_version,
        update_available=update_available,
        install_kind=install_kind,
        update_command=update_command,
        release_notes_url=notes_url,
    )

    _cache = {"timestamp": now, "data": info}
    return info

