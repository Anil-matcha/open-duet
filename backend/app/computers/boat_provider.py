"""Boat backed agent computers for the local Desktop profile.

The user's API key is read in this backend process only. It is never passed to
the sandbox, the local MCP child, or the model.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import posixpath
import re
import shlex
import time
import uuid
from urllib.parse import quote

import httpx

from app.computers import docker_cli, screen
from app.computers.docker_cli import Spec
from app.computers.provider import ComputerError, Health, McpLaunch, Status
from app.core.config import settings
from app.desktop import boat_credentials, profile
from app.computers import grants

BOAT_IMAGE = "boat/default"
GUEST_WORKSPACE = "/workspace"
_READY_STATES = {"ready", "idle", "running"}
_STOPPED_STATES = {"archived"}
_MAX_OUTPUT = 2_000_000
_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
_SCREENSHOT_PATH = "/tmp/open-dots-screen.png"


class BoatProvider:
    key = "boat"
    guest_workspace = GUEST_WORKSPACE

    def __init__(self, *, base_url: str | None = None, timeout: float = 35.0) -> None:
        self.base_url = (base_url or settings.BOAT_BASE_URL).rstrip("/")
        self.timeout = timeout

    def health(self) -> Health:
        if not profile.active():
            return Health("boat", False, error="Cloud computers are available in the Desktop app.")
        try:
            configured = boat_credentials.get_store().configured()
        except (OSError, boat_credentials.CredentialError):
            return Health("boat", False, error="The saved cloud key could not be read.")
        return Health("boat", configured, error=None if configured else "Add a Boat API key in the computer settings.")

    def image_present(self, image: str) -> bool:
        return True

    def pull(self, image: str) -> None:
        return None

    def update_limits(self, spec: Spec) -> None:
        # Boat selects resource size at sandbox creation. Desktop currently
        # exposes no per-computer resource-size control for this provider.
        return None

    def list_managed(self, instance: str) -> list[tuple[str, int | None]]:
        # We only ever remove sandboxes whose IDs are still in this profile's
        # database; there is no account-wide orphan scan.
        return []

    def remove_by_name(self, name: str, instance: str) -> None:
        return None

    def _key(self) -> str:
        if not profile.active():
            raise ComputerError("Cloud computers require the Desktop app.", "boat_desktop_only")
        try:
            key = boat_credentials.get_store().get()
        except (OSError, boat_credentials.CredentialError):
            raise ComputerError("The saved cloud key could not be read. Set it again in the computer settings.", "boat_key_unavailable") from None
        if not key:
            raise ComputerError("Add a Boat API key in the computer settings.", "boat_key_missing")
        return key

    def _request(self, method: str, path: str, *, body: dict | None = None, headers: dict | None = None, timeout: float | None = None) -> dict:
        token = self._key()
        parsed = httpx.URL(self.base_url)
        if parsed.scheme != "https" and parsed.host not in {"127.0.0.1", "localhost", "::1"}:
            raise ComputerError("The cloud API must use HTTPS.", "boat_invalid_url")
        request_headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        if body is not None:
            request_headers["Content-Type"] = "application/json"
        if headers:
            request_headers.update(headers)
        try:
            with httpx.Client(timeout=timeout or self.timeout, verify=settings.SSL_CERT_FILE or True, follow_redirects=False) as client:
                response = client.request(method, self.base_url + path, headers=request_headers, json=body)
        except httpx.TimeoutException:
            raise ComputerError("The cloud service did not answer in time. Try again.", "boat_timeout") from None
        except httpx.HTTPError:
            raise ComputerError("Could not reach the cloud service. Check the connection and try again.", "boat_unavailable") from None
        if response.status_code >= 400:
            code, message = _api_refusal(response.status_code)
            raise ComputerError(message, code)
        if response.status_code == 204 or not response.content:
            return {}
        try:
            data = response.json()
        except (json.JSONDecodeError, ValueError):
            raise ComputerError("The cloud service returned an unreadable response.", "boat_invalid_response") from None
        if not isinstance(data, dict):
            raise ComputerError("The cloud service returned an unreadable response.", "boat_invalid_response")
        return data

    @staticmethod
    def _sandbox(data: dict) -> dict:
        sandbox = data.get("sandbox")
        if not isinstance(sandbox, dict):
            raise ComputerError("The cloud service did not return a computer record.", "boat_invalid_response")
        return sandbox

    @staticmethod
    def _id(spec: Spec) -> str | None:
        value = spec.container_id
        return value if isinstance(value, str) and value.startswith("bx_") else None

    def _get(self, sandbox_id: str) -> dict:
        return self._sandbox(self._request("GET", f"/sandboxes/{quote(sandbox_id, safe='')}"))

    def status(self, spec: Spec) -> Status:
        sandbox_id = self._id(spec)
        if sandbox_id is None:
            return Status("missing")
        sandbox = self._get(sandbox_id)
        raw_state = sandbox.get("state")
        if raw_state in _READY_STATES:
            setup = sandbox.get("setupStatus")
            if setup in {"pending", "running"}:
                return Status("creating", container_id=sandbox_id, image=BOAT_IMAGE)
            if setup == "failed":
                return Status("unavailable", container_id=sandbox_id, problem="Cloud computer setup failed. Remove it and try again.")
            return Status(
                "running",
                container_id=sandbox_id,
                image=BOAT_IMAGE,
                started_at=sandbox.get("updatedAt"),
                desktop_ready=spec.kind == "desktop",
            )
        if raw_state in _STOPPED_STATES:
            return Status("stopped", container_id=sandbox_id, image=BOAT_IMAGE)
        if raw_state == "archiving":
            return Status("creating", container_id=sandbox_id, image=BOAT_IMAGE)
        if raw_state in {"provisioning", "provisioned", "cloning", "init"}:
            return Status("creating", container_id=sandbox_id, image=BOAT_IMAGE)
        if raw_state in {"error", "cancelled"}:
            return Status("unavailable", container_id=sandbox_id, problem="The cloud computer reported an error. Check its provider console.")
        return Status("unavailable", container_id=sandbox_id, problem="The cloud computer has an unknown state.")

    def create(self, spec: Spec) -> Status:
        sandbox_id = self._id(spec)
        if sandbox_id is None:
            setup = "mkdir -p /home/user/workspace"
            if spec.kind == "desktop":
                setup += "\nif ! command -v xdotool >/dev/null 2>&1 || ! command -v scrot >/dev/null 2>&1; then sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y xdotool scrot; fi"
            # Idle stopping is managed by the local lifecycle service. Provider
            # TTLs may delete the sandbox, so they must not mirror idle_minutes.
            idem = str(uuid.uuid5(uuid.NAMESPACE_URL, f"open-dots:{spec.instance}:{spec.computer_id}:{spec.provider_generation}"))
            data = self._request(
                "POST",
                "/sandboxes",
                body={
                    "type": "default",
                    "name": spec.name[:120],
                    "labels": {"open-dots/instance": spec.instance, "open-dots/computer": str(spec.computer_id)},
                    "noEnv": True,
                    "visibility": "private",
                    "monitoring": False,
                    # Let an unused cloud machine archive after one hour. The
                    # provider default would do this too, but set it explicitly
                    # so a later default change cannot leave it running forever.
                    "ttlSeconds": 3600,
                    "setupScript": setup,
                },
                headers={"Idempotency-Key": idem},
                timeout=120,
            )
            sandbox = self._sandbox(data)
            sandbox_id = sandbox.get("id")
            if not isinstance(sandbox_id, str) or not sandbox_id.startswith("bx_"):
                raise ComputerError("The cloud service did not return a valid computer ID.", "boat_invalid_response")
            # ComputerService persists this id before waiting for setup, so an
            # interrupted provisioning run can still be resumed.
            return Status("creating", container_id=sandbox_id, image=BOAT_IMAGE)
        current = self.status(spec)
        if current.state == "running":
            return current
        if current.state == "stopped":
            return self.start(spec)
        if current.state == "creating":
            return current
        raise ComputerError(current.problem or "The cloud computer is unavailable.", "boat_computer_unavailable")

    def start(self, spec: Spec) -> Status:
        sandbox_id = self._id(spec)
        if sandbox_id is None:
            raise ComputerError("The cloud computer does not exist yet.", "computer_missing")
        current = self.status(spec)
        if current.state == "running":
            return current
        if current.state == "stopped":
            self._request("POST", f"/sandboxes/{quote(sandbox_id, safe='')}/resume", body={"ttlSeconds": 3600})
        elif current.state != "creating":
            raise ComputerError("The cloud computer cannot be resumed. Recreate it from the computer panel.", "boat_computer_unavailable")
        return self._wait_ready(spec, sandbox_id, wait_setup=True)

    def _wait_ready(self, spec: Spec, sandbox_id: str, *, wait_setup: bool) -> Status:
        deadline = time.monotonic() + (300 if wait_setup else 150)
        while time.monotonic() < deadline:
            sandbox = self._get(sandbox_id)
            state = sandbox.get("state")
            if state in _READY_STATES:
                setup = sandbox.get("setupStatus")
                if wait_setup and setup in {"pending", "running"}:
                    time.sleep(2)
                    continue
                if setup == "failed":
                    raise ComputerError("Cloud computer setup failed. Remove it and try again.", "boat_setup_failed")
                return Status(
                    "running", container_id=sandbox_id, image=BOAT_IMAGE,
                    started_at=sandbox.get("updatedAt"), desktop_ready=spec.kind == "desktop",
                )
            if state in {"error", "cancelled"}:
                raise ComputerError("The cloud computer could not be started. Check the provider console.", "boat_create_failed")
            time.sleep(2)
        raise ComputerError("The cloud computer is still provisioning. Refresh its status in a moment.", "boat_provisioning")

    def stop(self, spec: Spec) -> Status:
        sandbox_id = self._id(spec)
        if sandbox_id is None:
            return Status("missing")
        sandbox = self._get(sandbox_id)
        raw_state = sandbox.get("state")
        if raw_state in _READY_STATES:
            self._request("POST", f"/sandboxes/{quote(sandbox_id, safe='')}/stop", body={})
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                sandbox = self._get(sandbox_id)
            except ComputerError as exc:
                if exc.code == "boat_computer_missing":
                    return Status("missing")
                raise
            raw_state = sandbox.get("state")
            if raw_state == "archived":
                return Status("stopped", container_id=sandbox_id, image=BOAT_IMAGE)
            if raw_state in {"error", "cancelled"}:
                raise ComputerError("The cloud computer could not be stopped. Check the provider console.", "boat_computer_unavailable")
            time.sleep(2)
        raise ComputerError("The cloud computer is still stopping. Refresh its status in a moment.", "boat_stopping")

    @staticmethod
    def _deletion_operation(data: dict) -> tuple[str, str]:
        operation = data.get("operation")
        if not isinstance(operation, dict):
            raise ComputerError("The cloud service did not return a deletion operation.", "boat_invalid_response")
        operation_id = operation.get("id")
        status = operation.get("status")
        if not isinstance(operation_id, str) or not re.fullmatch(r"bdop_[a-f0-9]{32}", operation_id):
            raise ComputerError("The cloud service returned an invalid deletion operation ID.", "boat_invalid_response")
        if status not in {"pending", "processing", "blocked", "completed"}:
            raise ComputerError("The cloud service returned an unknown deletion state.", "boat_invalid_response")
        return operation_id, status

    def delete(self, spec: Spec) -> str | None:
        if spec.provider_delete_id:
            operation_id = spec.provider_delete_id
            if not re.fullmatch(r"bdop_[a-f0-9]{32}", operation_id):
                raise ComputerError("The saved cloud deletion operation ID is invalid.", "boat_invalid_response")
            try:
                data = self._request("GET", f"/deletion-operations/{quote(operation_id, safe='')}")
            except ComputerError as exc:
                if exc.code != "boat_computer_missing":
                    raise
                sandbox_id = self._id(spec)
                if sandbox_id is None:
                    return None
                try:
                    self._get(sandbox_id)
                except ComputerError as sandbox_error:
                    if sandbox_error.code == "boat_computer_missing":
                        return None
                    raise
                # The operation record expired while the sandbox remained.
                # Reissue the already-requested deletion so upkeep can track a
                # fresh operation instead of leaving this agent locked forever.
                return self._request_sandbox_delete(sandbox_id)
            found_id, status = self._deletion_operation(data)
            if found_id != operation_id:
                raise ComputerError("The cloud service returned a different deletion operation.", "boat_invalid_response")
            if status == "completed":
                return None
            if status == "blocked":
                raise ComputerError("Cloud deletion is blocked by the provider. Check its console before retrying.", "boat_deletion_blocked")
            return operation_id

        sandbox_id = self._id(spec)
        if sandbox_id is None:
            return None
        return self._request_sandbox_delete(sandbox_id)

    def _request_sandbox_delete(self, sandbox_id: str) -> str | None:
        try:
            data = self._request(
                "DELETE", f"/sandboxes/{quote(sandbox_id, safe='')}",
                headers={"X-Ascii-Confirm-Delete": sandbox_id}, timeout=60,
            )
        except ComputerError as exc:
            if exc.code != "boat_computer_missing":
                raise
            return None
        operation_id, status = self._deletion_operation(data)
        if status == "completed":
            return None
        if status == "blocked":
            raise ComputerError("Cloud deletion is blocked by the provider. Check its console before retrying.", "boat_deletion_blocked")
        return operation_id

    def mcp_launch(self, spec: Spec, grants_dir, state_dir, *, turn_id: int | None = None) -> McpLaunch:
        if turn_id is None:
            raise ComputerError("A turn ID is required to launch cloud computer tools.", "boat_bridge_unavailable")
        launch, _ = self.mcp_launch_for_turn(spec, grants_dir, state_dir, turn_id)
        return launch

    def mcp_launch_for_turn(self, spec: Spec, grants_dir, state_dir, turn_id: int) -> tuple[McpLaunch, str]:
        from app.computers.provider import mcp_launch_for
        from app.desktop import computer_capabilities

        current = profile.current()
        if current is None:
            raise ComputerError("Cloud computers require the Desktop app.", "boat_desktop_only")
        token = computer_capabilities.issue(spec.computer_id, turn_id, grants_dir)
        capability_path = None
        try:
            capability_path = grants.private_dir(grants_dir) / "computer-capability"
            fd = os.open(capability_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="ascii") as stream:
                stream.write(token)
                stream.flush()
                os.fsync(stream.fileno())
            launch = mcp_launch_for(spec.name, spec.run_as, grants_dir, state_dir, None, spec.kind)
            launch.args.extend([
                "--provider", "boat", "--computer-id", str(spec.computer_id),
                "--api-origin", current.origin, "--turn-id", str(turn_id),
                "--capability-file", str(capability_path),
            ])
            return launch, token
        except Exception:
            computer_capabilities.revoke(token)
            if capability_path is not None:
                capability_path.unlink(missing_ok=True)
            raise

    def tool(self, spec: Spec, name: str, arguments: dict) -> dict:
        sandbox_id = self._id(spec)
        if sandbox_id is None:
            raise ComputerError("The cloud computer has not been created yet.", "computer_missing")
        path_id = quote(sandbox_id, safe="")
        if name == "exec":
            return self._exec(path_id, arguments)
        if name == "read_file":
            return self._read_file(path_id, arguments)
        if name == "write_file":
            return self._write_file(path_id, arguments)
        if name == "list_files":
            return self._list_files(path_id, arguments)
        if name in screen.DEFINITIONS:
            return self._screen(path_id, name, arguments)
        raise ComputerError("Unknown cloud computer tool.", "invalid_computer_tool")

    def screenshot(self, spec: Spec) -> bytes:
        if spec.kind != "desktop":
            raise ComputerError("This computer has no screen.", "not_a_desktop")
        sandbox_id = self._id(spec)
        if sandbox_id is None:
            raise ComputerError("Start the cloud computer to see its screen.", "computer_not_running")
        return self._capture_screenshot(sandbox_id)

    def _capture_screenshot(self, sandbox_id: str, *, area: tuple[int, int, int, int] | None = None) -> bytes:
        encoded_id = quote(sandbox_id, safe="")
        self._request("POST", f"/sandboxes/{encoded_id}/desktop?vnc=1", body={"publicAccess": False})
        result = self._command(sandbox_id, _screenshot_command(area), 20)
        if result.get("exitCode") != 0:
            raise ComputerError("The cloud desktop could not capture its screen. Try again after the desktop is ready.", "desktop_not_ready")

        response = self._request(
            "GET",
            f"/sandboxes/{encoded_id}/files?path={quote(_SCREENSHOT_PATH, safe='')}&encoding=base64",
        )
        content = response.get("content")
        if not isinstance(content, str) or len(content) > ((_MAX_SCREENSHOT_BYTES + 2) // 3) * 4:
            raise ComputerError("The cloud desktop screenshot is missing or too large.", "desktop_not_ready")
        try:
            raw = base64.b64decode(content, validate=True)
        except (ValueError, TypeError):
            raise ComputerError("The cloud desktop did not return a valid screenshot.", "desktop_not_ready") from None
        if len(raw) > _MAX_SCREENSHOT_BYTES or not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ComputerError("The cloud desktop did not return a valid screenshot.", "desktop_not_ready")
        return raw

    def desktop_url(self, spec: Spec) -> str:
        if spec.kind != "desktop":
            raise ComputerError("This computer has no screen.", "not_a_desktop")
        sandbox_id = self._id(spec)
        if sandbox_id is None:
            raise ComputerError("Start the cloud computer before opening its desktop.", "computer_not_running")
        data = self._request("POST", f"/sandboxes/{quote(sandbox_id, safe='')}/desktop?vnc=1", body={"publicAccess": False})
        url = data.get("desktopUrl")
        if not isinstance(url, str) or not url.startswith("https://"):
            raise ComputerError("The cloud desktop is still preparing. Try again in a moment.", "desktop_not_ready")
        return url

    def _command(self, sandbox_id: str, command: str, timeout: int, *, cwd: str = "workspace") -> dict:
        data = self._request(
            "POST", f"/sandboxes/{sandbox_id}/commands",
            body={"command": command, "cwd": cwd, "timeoutSeconds": max(1, min(timeout, 600))},
            timeout=max(self.timeout, timeout + 10),
        )
        if data.get("timedOut"):
            raise ComputerError("The cloud computer command timed out.", "boat_command_timeout")
        return data

    def _exec(self, sandbox_id: str, args: dict) -> dict:
        command = args.get("command")
        if not isinstance(command, str) or not command.strip() or len(command) > docker_cli.MAX_COMMAND_CHARS:
            raise ComputerError("The command is empty or too long.", "invalid_computer_tool")
        seconds = docker_cli.exec_seconds(args.get("timeout_seconds"))
        cwd = _boat_cwd(args.get("cwd"))
        result = self._command(sandbox_id, command, seconds, cwd=cwd)
        stdout = _clip(result.get("stdout", ""))
        stderr = _clip(result.get("stderr", ""))
        exit_code = result.get("exitCode")
        output = [f"exit code: {exit_code if exit_code is not None else 'none'}" + (" (timed out)" if result.get("timedOut") else "")]
        if stdout:
            output += ["--- stdout ---", stdout.rstrip("\n")]
        if stderr:
            output += ["--- stderr ---", stderr.rstrip("\n")]
        return _text("\n".join(output), error=exit_code not in (None, 0))

    def _read_file(self, sandbox_id: str, args: dict) -> dict:
        guest = _boat_file_path(args.get("path"))
        data = self._request("GET", f"/sandboxes/{sandbox_id}/files?path={quote(guest, safe='')}&encoding=base64")
        try:
            content = base64.b64decode(data.get("content", ""), validate=True)
        except (ValueError, TypeError):
            raise ComputerError("The cloud service returned an invalid file.", "boat_invalid_response") from None
        if len(content) > docker_cli.MAX_FILE_BYTES:
            raise ComputerError(f"The file is larger than {docker_cli.MAX_FILE_BYTES} bytes.", "file_too_large")
        if b"\x00" in content:
            raise ComputerError("This looks like a binary file; inspect it with exec instead.", "binary_file")
        return _text(content.decode("utf-8", errors="replace"))

    def _write_file(self, sandbox_id: str, args: dict) -> dict:
        guest = _boat_file_path(args.get("path"))
        content = args.get("content")
        if not isinstance(content, str) or len(content.encode("utf-8")) > docker_cli.MAX_FILE_BYTES:
            raise ComputerError("The file content is too large or invalid.", "invalid_computer_tool")
        self._request("PUT", f"/sandboxes/{sandbox_id}/files", body={
            "path": guest, "content": base64.b64encode(content.encode("utf-8")).decode("ascii"), "encoding": "base64",
        })
        return _text(f"Wrote {len(content.encode('utf-8'))} bytes to {args.get('path')}.")

    def _list_files(self, sandbox_id: str, args: dict) -> dict:
        guest = _boat_file_path(args.get("path") or ".")
        data = self._request("GET", f"/sandboxes/{sandbox_id}/files/list?path={quote(guest, safe='')}")
        files = data.get("files")
        if not isinstance(files, list):
            raise ComputerError("The cloud service returned an invalid file list.", "boat_invalid_response")
        lines = []
        for item in files[:1000]:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if isinstance(name, str):
                suffix = "/" if item.get("isDir") else ""
                lines.append(f"{name}{suffix}  {item.get('size', 0)} bytes")
        return _text("\n".join(lines) or "(empty folder)")

    def _screen(self, sandbox_id: str, name: str, args: dict) -> dict:
        if name == "wait":
            time.sleep(args["seconds"])
            return _text(f"Waited {args['seconds']} seconds.")
        if name == "screenshot":
            x, y = args.get("x", 0), args.get("y", 0)
            width, height = args.get("width", screen.WIDTH), args.get("height", screen.HEIGHT)
            issue = screen.validate(name, args)
            if issue:
                raise ComputerError(issue, "invalid_computer_tool")
            raw = self._capture_screenshot(sandbox_id, area=(x, y, width, height))
            return {
                "content": [
                    {"type": "text", "text": f"screen {screen.WIDTH}x{screen.HEIGHT}"},
                    {
                        "type": "image",
                        "mimeType": "image/png",
                        "data": base64.b64encode(raw).decode("ascii"),
                    },
                ]
            }
        args_list = screen.input_args(name, args)
        command = 'd=$(cat /tmp/open-dots-display 2>/dev/null); export DISPLAY="${d:-${DISPLAY:-:0}}"; ' + shlex.join(["xdotool", *args_list])
        result = self._command(sandbox_id, command, 25)
        if result.get("exitCode") != 0:
            raise ComputerError("The cloud screen action failed. Check that the desktop is ready.", "boat_screen_failed")
        subject = f"{len(args['text'])} characters" if name == "type" else json.dumps(args)
        return _text(f"{name}: {subject}")


def _screenshot_command(area: tuple[int, int, int, int] | None = None) -> str:
    if area is None:
        capture = (
            'scrot -o "$f" 2>/dev/null '
            '|| import -window root "$f" 2>/dev/null '
            '|| ffmpeg -y -f x11grab -draw_mouse 1 -i "$DISPLAY" -frames:v 1 "$f" >/dev/null 2>&1'
        )
    else:
        x, y, width, height = area
        capture = f'scrot -a {x},{y},{width},{height} -o "$f" 2>/dev/null'
    return (
        f'f={_SCREENSHOT_PATH}; rm -f "$f"; '
        'for display in "${DISPLAY:-}" :0 :1; do '
        '[ -n "$display" ] || continue; export DISPLAY="$display"; '
        f'{capture}; '
        'if test -s "$f"; then printf "%s\\n" "$DISPLAY" > /tmp/open-dots-display; echo captured; exit 0; fi; '
        'done; echo "The desktop display is not ready." >&2; exit 1'
    )


def _with_container_id(spec: Spec, container_id: str) -> Spec:
    from dataclasses import replace

    return replace(spec, container_id=container_id)


def _api_refusal(status: int) -> tuple[str, str]:
    if status == 401:
        return "boat_auth_failed", "The cloud API key was rejected. Update it in the computer settings."
    if status in {402, 403}:
        return "boat_plan_restricted", "The cloud account cannot create or operate this computer right now. Check its plan and access."
    if status == 404:
        return "boat_computer_missing", "The cloud computer no longer exists. Remove its record and create a new one."
    if status == 429:
        return "boat_rate_limited", "The cloud service is rate limited. Try again in a moment."
    if status == 503:
        return "boat_unavailable", "The cloud service cannot start a computer right now. Try again shortly."
    return "boat_request_failed", f"The cloud service refused the request ({status}). Check the computer settings and try again."


def _boat_file_path(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value or len(value) > 4096:
        raise ComputerError("A valid file path is required.", "invalid_computer_tool")
    raw = value.strip()
    if raw == "/workspace":
        return "/home/user/workspace"
    if raw.startswith("/workspace/"):
        relative = raw[len("/workspace/"):]
    elif raw.startswith("/"):
        if not raw.startswith("/tmp/"):
            raise ComputerError("Cloud file tools can access only the computer workspace and /tmp.", "invalid_computer_tool")
        candidate = posixpath.normpath(raw)
        if candidate != "/tmp" and not candidate.startswith("/tmp/"):
            raise ComputerError("The file path leaves /tmp.", "invalid_computer_tool")
        return candidate
    else:
        relative = raw
    normalized = posixpath.normpath("/home/user/workspace/" + relative)
    if normalized != "/home/user/workspace" and not normalized.startswith("/home/user/workspace/"):
        raise ComputerError("The file path leaves the computer workspace.", "invalid_computer_tool")
    return normalized


def _boat_cwd(value: object) -> str:
    if value is None:
        return "workspace"
    if not isinstance(value, str) or "\x00" in value or len(value) > 4096:
        raise ComputerError("Invalid working directory.", "invalid_computer_tool")
    raw = value.strip()
    if raw == "/workspace":
        return "workspace"
    if raw.startswith("/workspace/"):
        raw = raw[len("/workspace/"):]
    normalized = posixpath.normpath(raw or "workspace")
    if normalized in {".", ""}:
        return "workspace"
    if normalized.startswith("/") or normalized == ".." or normalized.startswith("../"):
        raise ComputerError("The working directory must stay under the computer workspace.", "invalid_computer_tool")
    return "workspace/" + normalized


def _clip(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return value[:_MAX_OUTPUT]


def _text(value: str, *, error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": value}], **({"isError": True} if error else {})}
