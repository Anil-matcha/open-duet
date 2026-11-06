"""Muapi cloud computers: the Muapi Sandbox API (api.muapi.ai/api/v1/sandboxes).

Reuses BoatProvider's tool bridge, path rules and output handling; replaces
only what differs on the wire: x-api-key auth, the Muapi sandbox record shape,
synchronous create/stop/delete, and plain-text file bodies. Shell computers
only: Muapi sandboxes have no desktop/screen yet.
"""

from __future__ import annotations

import posixpath
import re
import shlex
import uuid
from urllib.parse import quote

import httpx

from app.computers import docker_cli
from app.computers.boat_provider import (
    BoatProvider, _boat_cwd, _boat_file_path, _clip, _text, GUEST_WORKSPACE,
)
from app.computers.provider import ComputerError, Health, Status
from app.core.config import settings
from app.desktop import muapi_credentials, profile

MUAPI_IMAGE = "muapi/default"
_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _muapi_refusal(status: int) -> tuple[str, str]:
    if status == 401:
        return "muapi_auth_failed", "The Muapi API key was rejected. Update it in the computer settings."
    if status == 402:
        return "muapi_insufficient_credits", "Not enough Muapi credits (a $1 balance is needed to start a computer). Top up at muapi.ai."
    if status in {403, 409}:
        return "muapi_plan_restricted", "The Muapi account cannot create or operate this computer right now."
    if status == 404:
        return "boat_computer_missing", "The cloud computer no longer exists. Remove its record and create a new one."
    if status == 429:
        return "muapi_rate_limited", "Muapi is rate limited or the computer limit was reached. Try again later or remove an unused computer."
    if status in {502, 503}:
        return "boat_unavailable", "Muapi cannot start a computer right now. Try again shortly."
    return "muapi_request_failed", f"Muapi refused the request ({status}). Check the computer settings and try again."


class MuapiProvider(BoatProvider):
    key = "muapi"
    guest_workspace = GUEST_WORKSPACE

    def __init__(self, *, base_url: str | None = None, timeout: float = 35.0) -> None:
        super().__init__(base_url=base_url or settings.MUAPI_SANDBOX_BASE_URL, timeout=timeout)

    def health(self) -> Health:
        if not profile.active():
            return Health("muapi", False, error="Cloud computers are available in the Desktop app.")
        try:
            configured = muapi_credentials.get_store().configured()
        except (OSError, muapi_credentials.CredentialError):
            return Health("muapi", False, error="The saved Muapi key could not be read.")
        return Health("muapi", configured, error=None if configured else "Add a Muapi API key in the computer settings.")

    def _key(self) -> str:
        if not profile.active():
            raise ComputerError("Cloud computers require the Desktop app.", "boat_desktop_only")
        try:
            key = muapi_credentials.get_store().get()
        except (OSError, muapi_credentials.CredentialError):
            raise ComputerError("The saved Muapi key could not be read. Set it again in the computer settings.", "boat_key_unavailable") from None
        if not key:
            raise ComputerError("Add a Muapi API key in the computer settings.", "muapi_key_missing")
        return key

    def _request(self, method: str, path: str, *, body: dict | None = None, headers: dict | None = None, timeout: float | None = None) -> dict:
        token = self._key()
        parsed = httpx.URL(self.base_url)
        if parsed.scheme != "https" and parsed.host not in {"127.0.0.1", "localhost", "::1"}:
            raise ComputerError("The cloud API must use HTTPS.", "boat_invalid_url")
        request_headers = {"x-api-key": token, "Accept": "application/json"}
        if headers:
            request_headers.update(headers)
        try:
            with httpx.Client(timeout=timeout or self.timeout, verify=settings.SSL_CERT_FILE or True, follow_redirects=False) as client:
                response = client.request(method, self.base_url + path, headers=request_headers, json=body)
        except httpx.TimeoutException:
            raise ComputerError("Muapi did not answer in time. Try again.", "boat_timeout") from None
        except httpx.HTTPError:
            raise ComputerError("Could not reach Muapi. Check the connection and try again.", "boat_unavailable") from None
        if response.status_code >= 400:
            code, message = _muapi_refusal(response.status_code)
            raise ComputerError(message, code)
        if response.status_code == 204 or not response.content:
            return {}
        try:
            data = response.json()
        except ValueError:
            raise ComputerError("Muapi returned an unreadable response.", "boat_invalid_response") from None
        if not isinstance(data, dict):
            raise ComputerError("Muapi returned an unreadable response.", "boat_invalid_response")
        return data

    @staticmethod
    def _id(spec) -> str | None:
        value = spec.container_id
        return value if isinstance(value, str) and _ID.match(value) else None

    def _get(self, sandbox_id: str) -> dict:
        return self._request("GET", f"/sandboxes/{quote(sandbox_id, safe='')}")

    def status(self, spec) -> Status:
        sandbox_id = self._id(spec)
        if sandbox_id is None:
            return Status("missing")
        state = self._get(sandbox_id).get("state")
        if state == "running":
            return Status("running", container_id=sandbox_id, image=MUAPI_IMAGE)
        if state == "stopped":
            return Status("stopped", container_id=sandbox_id, image=MUAPI_IMAGE)
        if state == "creating":
            return Status("creating", container_id=sandbox_id, image=MUAPI_IMAGE)
        if state == "deleted":
            return Status("missing")
        return Status("unavailable", container_id=sandbox_id, problem="The Muapi computer is unavailable. Remove it and create a new one.")

    def create(self, spec) -> Status:
        if spec.kind != "shell":
            raise ComputerError("Muapi computers are shell-only for now.", "muapi_shell_only")
        sandbox_id = self._id(spec)
        if sandbox_id is None:
            # Muapi creates synchronously: it returns once the machine is ready.
            data = self._request("POST", "/sandboxes", body={"profile": "default"}, timeout=180)
            new_id = data.get("id")
            if not isinstance(new_id, str) or not _ID.match(new_id):
                raise ComputerError("Muapi did not return a valid computer ID.", "boat_invalid_response")
            self._request(
                "POST", f"/sandboxes/{new_id}/commands",
                body={"command": "mkdir -p /home/user/workspace", "timeout_seconds": 30},
            )
            return Status("running", container_id=new_id, image=MUAPI_IMAGE)
        current = self.status(spec)
        if current.state == "running":
            return current
        if current.state == "stopped":
            return self.start(spec)
        raise ComputerError(current.problem or "The Muapi computer is unavailable.", "boat_computer_unavailable")

    def start(self, spec) -> Status:
        sandbox_id = self._id(spec)
        if sandbox_id is None:
            raise ComputerError("The cloud computer does not exist yet.", "computer_missing")
        current = self.status(spec)
        if current.state == "running":
            return current
        if current.state != "stopped":
            raise ComputerError("The Muapi computer cannot be resumed. Recreate it from the computer panel.", "boat_computer_unavailable")
        self._request("POST", f"/sandboxes/{sandbox_id}/resume", body={}, timeout=180)
        return Status("running", container_id=sandbox_id, image=MUAPI_IMAGE)

    def stop(self, spec) -> Status:
        sandbox_id = self._id(spec)
        if sandbox_id is None:
            return Status("missing")
        try:
            sandbox = self._get(sandbox_id)
            if sandbox.get("state") == "running":
                self._request("POST", f"/sandboxes/{sandbox_id}/stop", body={}, timeout=120)
        except ComputerError as exc:
            if exc.code == "boat_computer_missing":
                return Status("missing")
            raise
        return Status("stopped", container_id=sandbox_id, image=MUAPI_IMAGE)

    def delete(self, spec) -> str | None:
        sandbox_id = self._id(spec)
        if sandbox_id is None:
            return None
        try:
            self._request("DELETE", f"/sandboxes/{sandbox_id}", timeout=120)
        except ComputerError as exc:
            if exc.code != "boat_computer_missing":
                raise
        return None  # synchronous: no pending deletion operation to track

    def _command(self, sandbox_id: str, command: str, timeout: int, *, cwd: str = "workspace") -> dict:
        data = self._request(
            "POST", f"/sandboxes/{sandbox_id}/commands",
            body={"command": command, "cwd": cwd, "timeout_seconds": max(1, min(timeout, 600))},
            timeout=max(self.timeout, timeout + 10),
        )
        if data.get("timedOut"):
            raise ComputerError("The cloud computer command timed out.", "boat_command_timeout")
        return data

    def _read_file(self, sandbox_id: str, args: dict) -> dict:
        guest = _boat_file_path(args.get("path"))
        data = self._request("GET", f"/sandboxes/{sandbox_id}/files?path={quote(guest, safe='')}")
        content = data.get("content", "")
        if not isinstance(content, str):
            raise ComputerError("Muapi returned an invalid file.", "boat_invalid_response")
        raw = content.encode("utf-8")
        if len(raw) > docker_cli.MAX_FILE_BYTES:
            raise ComputerError(f"The file is larger than {docker_cli.MAX_FILE_BYTES} bytes.", "file_too_large")
        if "\x00" in content:
            raise ComputerError("This looks like a binary file; inspect it with exec instead.", "binary_file")
        return _text(content)

    def _write_file(self, sandbox_id: str, args: dict) -> dict:
        guest = _boat_file_path(args.get("path"))
        content = args.get("content")
        if not isinstance(content, str) or len(content.encode("utf-8")) > docker_cli.MAX_FILE_BYTES:
            raise ComputerError("The file content is too large or invalid.", "invalid_computer_tool")
        self._request("PUT", f"/sandboxes/{sandbox_id}/files", body={"path": guest, "content": content})
        return _text(f"Wrote {len(content.encode('utf-8'))} bytes to {args.get('path')}.")

    def _list_files(self, sandbox_id: str, args: dict) -> dict:
        guest = _boat_file_path(args.get("path") or "/workspace")
        result = self._command(sandbox_id, f"ls -1Ap -- {shlex.quote(guest)}", 30, cwd="workspace")
        if result.get("exitCode") not in (None, 0):
            return _text(_clip(result.get("stderr")) or "The folder could not be listed.", error=True)
        return _text(_clip(result.get("stdout", "")))

    def mcp_launch_for_turn(self, spec, grants_dir, state_dir, turn_id: int):
        launch, token = super().mcp_launch_for_turn(spec, grants_dir, state_dir, turn_id)
        i = launch.args.index("--provider")
        launch.args[i + 1] = "muapi"
        return launch, token

    def screenshot(self, spec):
        raise ComputerError("This computer has no screen.", "not_a_desktop")

    def desktop_url(self, spec):
        raise ComputerError("This computer has no screen.", "not_a_desktop")
