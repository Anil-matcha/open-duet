"""boxd backed agent computers for the local Desktop profile.

boxd (https://boxd.sh/?ref=open-duet) runs full Linux microVMs (KVM) with a
persistent disk that start in about a second and can be hibernated. Each agent
computer is one boxd machine. Commands, files and screen actions go through the
boxd API (`pip install boxd`, the optional `boxd` extra of this backend).

The user's API key is read in this backend process only. It is never passed to
the machine, the local MCP child, or the model.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import posixpath
import shlex
import threading
import time

from app.computers import docker_cli, grants, screen
from app.computers.docker_cli import Spec
from app.computers.provider import ComputerError, Health, McpLaunch, Status
from app.desktop import boxd_credentials, profile

BOXD_IMAGE = "boxd/default"
GUEST_WORKSPACE = "/workspace"
# The machine's own user and the folder that stands in for /workspace.
_HOME = "/home/boxd"
_WORKSPACE = _HOME + "/workspace"
_MAX_OUTPUT = 2_000_000
_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
LABEL_INSTANCE = "open-dots/instance"
LABEL_COMPUTER = "open-dots/computer"
LABEL_GENERATION = "open-dots/generation"

# A desktop computer gets its own 1280x800 X display, separate from the
# machine's desktop (display :100, the boxd console's Desktop view), whose
# size follows whoever watches it. A transient systemd unit keeps it running
# between commands; hibernation keeps it and its windows.
DISPLAY = ":99"
_DISPLAY_UNIT = "open-dots-display"
_START_DISPLAY = (
    f"if ! systemctl is-active --quiet {_DISPLAY_UNIT}; then "
    f"sudo systemctl reset-failed {_DISPLAY_UNIT} >/dev/null 2>&1; "
    f"sudo systemd-run --quiet --unit={_DISPLAY_UNIT} --uid=boxd --gid=boxd -p Restart=always "
    f"/usr/bin/Xvfb {DISPLAY} -screen 0 {screen.WIDTH}x{screen.HEIGHT}x24 -nolisten tcp; fi; "
    f"for i in $(seq 1 50); do xdpyinfo -display {DISPLAY} >/dev/null 2>&1 && break; sleep 0.1; done"
)
_ENSURE_DISPLAY = _START_DISPLAY + f'; xdpyinfo -display {DISPLAY} >/dev/null 2>&1 || {{ echo "The desktop display did not start." >&2; exit 1; }}'

_RUNNING = {"running", "suspended"}  # a suspended machine wakes on its next request
_CREATING = {"pending", "starting", "migrating"}
_STOPPED = {"hibernated", "stopped"}


class BoxdProvider:
    key = "boxd"
    guest_workspace = GUEST_WORKSPACE

    def __init__(
        self,
        *,
        client_factory=None,
        name_prefix: str | None = None,
        labels: dict[str, str] | None = None,
        delete_after: int | None = None,
        timeout: float = 60.0,
    ) -> None:
        # `client_factory(api_key)` returns a `boxd.Boxd`-like client; tests
        # pass a fake. `name_prefix`, `labels` and `delete_after` are passed
        # to every machine this provider makes (the app passes none of them).
        self._client_factory = client_factory
        self.name_prefix = name_prefix
        self.labels = dict(labels or {})
        self.delete_after = delete_after
        self.timeout = timeout
        self._clients: dict[str, object] = {}
        self._clients_lock = threading.Lock()

    # -- health and inspection ---------------------------------------------------------

    def health(self) -> Health:
        if not profile.active():
            return Health("boxd", False, error="Cloud computers are available in the Desktop app.")
        if self._client_factory is None and not sdk_installed():
            return Health("boxd", False, error="The boxd SDK is not installed. Install the backend with its boxd extra (uv sync --extra boxd).")
        try:
            configured = boxd_credentials.get_store().configured()
        except (OSError, boxd_credentials.CredentialError):
            return Health("boxd", False, error="The saved boxd key could not be read.")
        return Health("boxd", configured, error=None if configured else "Add a boxd API key in the computer settings.")

    def image_present(self, image: str) -> bool:
        return True

    def pull(self, image: str) -> None:
        return None

    def update_limits(self, spec: Spec) -> None:
        # Machines get the org's default size at creation. Desktop exposes no
        # per-computer size control for cloud computers.
        return None

    def list_managed(self, instance: str) -> list[tuple[str, int | None]]:
        # Like Boat: only machines whose IDs are in this profile's database are
        # ever removed; there is no account-wide orphan scan.
        return []

    def remove_by_name(self, name: str, instance: str) -> None:
        return None

    # -- the API -----------------------------------------------------------------------

    def _client(self):
        if not profile.active():
            raise ComputerError("Cloud computers require the Desktop app.", "boxd_desktop_only")
        try:
            key = boxd_credentials.get_store().get()
        except (OSError, boxd_credentials.CredentialError):
            raise ComputerError("The saved boxd key could not be read. Set it again in the computer settings.", "boxd_key_unavailable") from None
        if not key:
            raise ComputerError("Add a boxd API key in the computer settings.", "boxd_key_missing")
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        with self._clients_lock:
            client = self._clients.get(digest)
            if client is None:
                factory = self._client_factory or _sdk_client
                client = factory(key)
                # One key at a time: a replaced key's client is dropped.
                self._clients = {digest: client}
            return client

    def _call(self, what: str, fn, *args, **kwargs):
        """Run one SDK call, turning its errors into ComputerErrors."""
        try:
            return fn(*args, **kwargs)
        except ComputerError:
            raise
        except Exception as exc:  # noqa: BLE001  (the SDK is imported lazily; classify by name)
            raise _refusal(exc, what) from None

    @staticmethod
    def _id(spec: Spec) -> str | None:
        value = spec.container_id
        return value if isinstance(value, str) and value else None

    def machine_name(self, spec: Spec) -> str:
        if self.name_prefix:
            return f"{self.name_prefix}{spec.computer_id}"
        return spec.name

    def _labels(self, spec: Spec) -> dict[str, str]:
        return {
            **self.labels,
            LABEL_INSTANCE: spec.instance,
            LABEL_COMPUTER: str(spec.computer_id),
            LABEL_GENERATION: spec.provider_generation,
        }

    @staticmethod
    def _ours(machine, spec: Spec) -> bool:
        labels = getattr(machine, "labels", None) or {}
        return labels.get(LABEL_INSTANCE) == spec.instance and labels.get(LABEL_COMPUTER) == str(spec.computer_id)

    def _get(self, client, machine_id: str):
        """The machine, or None when boxd no longer has it."""
        try:
            return client.machines.get(machine_id)
        except Exception as exc:  # noqa: BLE001
            if _error_name(exc) == "NotFoundError":
                return None
            raise _refusal(exc, "read the machine") from None

    # -- lifecycle ---------------------------------------------------------------------

    def status(self, spec: Spec) -> Status:
        machine_id = self._id(spec)
        if machine_id is None:
            return Status("missing")
        machine = self._get(self._client(), machine_id)
        return self._status_of(machine, spec)

    def _status_of(self, machine, spec: Spec) -> Status:
        if machine is None:
            return Status("missing")
        if not self._ours(machine, spec):
            return Status(
                "foreign", container_id=machine.id,
                problem="The boxd machine saved for this computer was not made by Open Dots for this agent. Remove the computer and create it again.",
            )
        state = machine.status
        if state in _RUNNING:
            return Status(
                "running", container_id=machine.id, image=BOXD_IMAGE,
                started_at=_iso(getattr(machine, "created_at", None)), desktop_ready=spec.kind == "desktop",
            )
        if state in _STOPPED:
            return Status("stopped", container_id=machine.id, image=BOXD_IMAGE)
        if state in _CREATING:
            return Status("creating", container_id=machine.id, image=BOXD_IMAGE)
        if state == "destroyed":
            return Status("missing")
        if state == "failed":
            return Status("unavailable", container_id=machine.id, problem="The boxd machine failed. Recreate the computer.")
        return Status("unavailable", container_id=machine.id, problem=f"The boxd machine is {state}.")

    def create(self, spec: Spec) -> Status:
        client = self._client()
        if self._id(spec) is not None:
            current = self.status(spec)
            if current.state == "running":
                return current
            if current.state in ("stopped", "creating"):
                return self.start(spec) if current.state == "stopped" else current
            if current.state != "missing":
                raise ComputerError(current.problem or "The boxd machine is unavailable.", "boxd_computer_unavailable")
            # The machine is gone (removed in the boxd console, or by a
            # delete-after timer): make a new one under the same identity.
        name = self.machine_name(spec)
        options: dict = {"labels": self._labels(spec)}
        if self.delete_after:
            options["delete_after"] = self.delete_after
        try:
            machine = client.machines.create(name, **options)
        except Exception as exc:  # noqa: BLE001
            if _error_name(exc) != "ConflictError":
                raise _refusal(exc, "create the machine") from None
            # The name is taken. A create that was cut short after boxd made
            # the machine is resumed; anyone else's machine is refused.
            machine = self._get(client, name)
            if machine is None or not self._ours(machine, spec) or (machine.labels or {}).get(LABEL_GENERATION) != spec.provider_generation:
                raise ComputerError(
                    f"A boxd machine named {name} already exists and was not made for this computer. Rename or remove it in boxd.",
                    "boxd_name_taken",
                ) from None
        machine_id = getattr(machine, "id", None)
        if not isinstance(machine_id, str) or not machine_id:
            raise ComputerError("boxd did not return a machine ID.", "boxd_invalid_response")
        # ComputerService saves this id before it waits for the machine, so an
        # interrupted start can be resumed.
        return Status("creating", container_id=machine_id, image=BOXD_IMAGE)

    def start(self, spec: Spec) -> Status:
        machine_id = self._id(spec)
        if machine_id is None:
            raise ComputerError("The boxd machine does not exist yet.", "computer_missing")
        client = self._client()
        machine = self._get(client, machine_id)
        current = self._status_of(machine, spec)
        if current.state == "missing":
            raise ComputerError("The boxd machine no longer exists. Start the computer again to make a new one.", "boxd_computer_missing")
        if current.state not in ("running", "stopped", "creating"):
            raise ComputerError(current.problem or "The boxd machine cannot be started.", "boxd_computer_unavailable")
        if machine.status == "hibernated":
            self._call("wake the machine", client.machines.wake, machine_id)
        elif machine.status == "stopped":
            self._call("start the machine", client.machines.start, machine_id)
        try:
            client.machines.wait_until_ready(machine_id, timeout=180)
        except TimeoutError:
            raise ComputerError("The boxd machine is still starting. Refresh its status in a moment.", "boxd_provisioning") from None
        except Exception as exc:  # noqa: BLE001
            raise _refusal(exc, "start the machine") from None
        self._setup(client, machine_id, spec)
        return self._status_of(self._get(client, machine_id), spec)

    def _setup(self, client, machine_id: str, spec: Spec) -> None:
        """Make the workspace folder and, for a desktop, its display. Cheap and
        idempotent, so it runs on every start."""
        script = f"mkdir -p {_WORKSPACE}"
        if spec.kind == "desktop":
            script += "; " + _ENSURE_DISPLAY
        result = self._call("prepare the machine", client.machines.exec, machine_id, ["bash", "-c", script], timeout=60)
        if result.exit_code != 0:
            raise ComputerError("The boxd machine could not be prepared: " + _tail(result.stderr), "boxd_setup_failed")

    def stop(self, spec: Spec) -> Status:
        """Hibernate: memory and disk are kept (open apps included) and the
        machine wakes in about a second on the next start."""
        machine_id = self._id(spec)
        if machine_id is None:
            return Status("missing")
        client = self._client()
        machine = self._get(client, machine_id)
        current = self._status_of(machine, spec)
        if current.state != "running":
            return current
        self._call("hibernate the machine", client.machines.hibernate, machine_id)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            current = self._status_of(self._get(client, machine_id), spec)
            if current.state in ("stopped", "missing"):
                return current
            if current.state not in ("running", "creating"):
                raise ComputerError(current.problem or "The boxd machine could not be stopped.", "boxd_computer_unavailable")
            time.sleep(1)
        raise ComputerError("The boxd machine is still hibernating. Refresh its status in a moment.", "boxd_stopping")

    def delete(self, spec: Spec) -> str | None:
        """Remove the machine and its disk. boxd deletes synchronously, so
        nothing is ever left pending."""
        machine_id = self._id(spec)
        if machine_id is None:
            return None
        client = self._client()
        machine = self._get(client, machine_id)
        if machine is None:
            return None
        if not self._ours(machine, spec):
            raise ComputerError("The saved boxd machine was not made by Open Dots for this agent; it was left alone.", "computer_foreign")
        try:
            client.machines.delete(machine_id)
        except Exception as exc:  # noqa: BLE001
            if _error_name(exc) != "NotFoundError":
                raise _refusal(exc, "remove the machine") from None
        # The call returns before every read sees the machine gone; wait, so
        # that a recreate can take the same name again.
        deadline = time.monotonic() + 30
        while self._get(client, machine_id) is not None:
            if time.monotonic() > deadline:
                raise ComputerError("boxd is still removing the machine. Try again in a moment.", "boxd_stopping")
            time.sleep(0.5)
        return None

    # -- tools -------------------------------------------------------------------------

    def mcp_launch(self, spec: Spec, grants_dir, state_dir, *, turn_id: int | None = None) -> McpLaunch:
        if turn_id is None:
            raise ComputerError("A turn ID is required to launch cloud computer tools.", "boxd_bridge_unavailable")
        launch, _ = self.mcp_launch_for_turn(spec, grants_dir, state_dir, turn_id)
        return launch

    def mcp_launch_for_turn(self, spec: Spec, grants_dir, state_dir, turn_id: int) -> tuple[McpLaunch, str]:
        from app.computers.provider import mcp_launch_for
        from app.desktop import computer_capabilities

        current = profile.current()
        if current is None:
            raise ComputerError("Cloud computers require the Desktop app.", "boxd_desktop_only")
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
                "--provider", "boxd", "--computer-id", str(spec.computer_id),
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
        machine_id = self._id(spec)
        if machine_id is None:
            raise ComputerError("The boxd machine has not been created yet.", "computer_missing")
        client = self._client()
        if name == "exec":
            return self._exec(client, machine_id, spec, arguments)
        if name == "read_file":
            return self._read_file(client, machine_id, arguments)
        if name == "write_file":
            return self._write_file(client, machine_id, arguments)
        if name == "list_files":
            return self._list_files(client, machine_id, arguments)
        if name in screen.DEFINITIONS:
            if spec.kind != "desktop":
                raise ComputerError("This computer has no screen.", "not_a_desktop")
            return self._screen(client, machine_id, name, arguments)
        raise ComputerError("Unknown cloud computer tool.", "invalid_computer_tool")

    def screenshot(self, spec: Spec) -> bytes:
        if spec.kind != "desktop":
            raise ComputerError("This computer has no screen.", "not_a_desktop")
        machine_id = self._id(spec)
        if machine_id is None:
            raise ComputerError("Start the cloud computer to see its screen.", "computer_not_running")
        return self._capture(self._client(), machine_id)

    def _run(self, client, machine_id: str, script: str, seconds: int, *, cwd: str | None = None, display: bool = False, binary: bool = False):
        argv = ["timeout", "-k", "5", str(seconds), "bash", "-c", script]
        options: dict = {"timeout": seconds + 30}
        if cwd:
            options["cwd"] = cwd
        if display:
            options["env"] = {"DISPLAY": DISPLAY}
        if binary:
            options["encoding"] = "buffer"
        try:
            return client.machines.exec(machine_id, argv, **options)
        except Exception as exc:  # noqa: BLE001
            if str(exc).startswith("exec timed out"):
                raise ComputerError("The boxd command timed out.", "boxd_command_timeout") from None
            raise _refusal(exc, "run the command") from None

    def _exec(self, client, machine_id: str, spec: Spec, args: dict) -> dict:
        command = args.get("command")
        if not isinstance(command, str) or not command.strip() or len(command) > docker_cli.MAX_COMMAND_CHARS:
            raise ComputerError("The command is empty or too long.", "invalid_computer_tool")
        try:
            seconds = docker_cli.exec_seconds(args.get("timeout_seconds"))
        except docker_cli.InvalidSpec as exc:
            raise ComputerError(str(exc), "invalid_computer_tool") from None
        cwd = _boxd_cwd(args.get("cwd"))
        result = self._run(client, machine_id, command, seconds, cwd=cwd, display=spec.kind == "desktop")
        stdout, stderr = _clip(result.stdout), _clip(result.stderr)
        code = result.exit_code
        timed_out = code in (124, 137)
        output = [f"exit code: {code}" + (" (timed out)" if timed_out else "")]
        if stdout:
            output += ["--- stdout ---", stdout.rstrip("\n")]
        if stderr:
            output += ["--- stderr ---", stderr.rstrip("\n")]
        return _text("\n".join(output), error=code != 0)

    def _read_file(self, client, machine_id: str, args: dict) -> dict:
        guest = _boxd_file_path(args.get("path"))
        try:
            content = client.machines.fs.read(machine_id, guest, length=docker_cli.MAX_FILE_BYTES + 1)
        except Exception as exc:  # noqa: BLE001
            problem = _file_problem(exc)
            if problem:
                return _text(problem, error=True)
            raise _refusal(exc, "read the file") from None
        if len(content) > docker_cli.MAX_FILE_BYTES:
            return _text(f"The file is larger than {docker_cli.MAX_FILE_BYTES} bytes; read a part with exec (head, sed -n).", error=True)
        if b"\x00" in content:
            return _text("This looks like a binary file; inspect it with exec instead.", error=True)
        return _text(content.decode("utf-8", errors="replace"))

    def _write_file(self, client, machine_id: str, args: dict) -> dict:
        guest = _boxd_file_path(args.get("path"))
        content = args.get("content")
        if not isinstance(content, str) or len(content.encode("utf-8")) > docker_cli.MAX_FILE_BYTES:
            raise ComputerError("The file content is too large or invalid.", "invalid_computer_tool")
        data = content.encode("utf-8")
        try:
            client.machines.fs.write(machine_id, guest, data)
        except Exception as exc:  # noqa: BLE001
            problem = _file_problem(exc)
            if problem:
                return _text(problem, error=True)
            raise _refusal(exc, "write the file") from None
        return _text(f"Wrote {len(data)} bytes to {args.get('path')}.")

    def _list_files(self, client, machine_id: str, args: dict) -> dict:
        guest = _boxd_file_path(args.get("path") or ".")
        try:
            entries = client.machines.fs.list(machine_id, guest)
        except Exception as exc:  # noqa: BLE001
            problem = _file_problem(exc)
            if problem:
                return _text(problem, error=True)
            raise _refusal(exc, "list the folder") from None
        lines = []
        for entry in sorted(entries, key=lambda item: item.name)[:1000]:
            suffix = "/" if entry.is_dir else ""
            lines.append(f"{entry.name}{suffix}  {entry.size if not entry.is_dir else 0} bytes")
        return _text("\n".join(lines) or "(empty folder)")

    def _capture(self, client, machine_id: str, area: tuple[int, int, int, int] | None = None) -> bytes:
        crop = ""
        if area is not None:
            x, y, width, height = area
            crop = f" -crop {width}x{height}+{x}+{y} +repage"
        script = _ENSURE_DISPLAY + f"; import -window root{crop} png:-"
        result = self._run(client, machine_id, script, 20, display=True, binary=True)
        raw = result.stdout if isinstance(result.stdout, bytes) else b""
        if result.exit_code != 0 or not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ComputerError("The boxd desktop could not capture its screen. Try again after the desktop is ready.", "desktop_not_ready")
        if len(raw) > _MAX_SCREENSHOT_BYTES:
            raise ComputerError("The boxd desktop screenshot is too large.", "desktop_not_ready")
        return raw

    def _screen(self, client, machine_id: str, name: str, args: dict) -> dict:
        issue = screen.validate(name, args)
        if issue:
            raise ComputerError(issue, "invalid_computer_tool")
        if name == "wait":
            time.sleep(args["seconds"])
            return _text(f"Waited {args['seconds']} seconds.")
        if name == "screenshot":
            area = (args.get("x", 0), args.get("y", 0), args.get("width", screen.WIDTH), args.get("height", screen.HEIGHT))
            raw = self._capture(client, machine_id, area)
            return {
                "content": [
                    {"type": "text", "text": f"screen {screen.WIDTH}x{screen.HEIGHT}"},
                    {"type": "image", "mimeType": "image/png", "data": base64.b64encode(raw).decode("ascii")},
                ]
            }
        script = _ENSURE_DISPLAY + "; " + shlex.join(["xdotool", *screen.input_args(name, args)])
        result = self._run(client, machine_id, script, 25, display=True)
        if result.exit_code != 0:
            raise ComputerError("The boxd screen action failed. Check that the desktop is ready.", "boxd_screen_failed")
        subject = f"{len(args['text'])} characters" if name == "type" else json.dumps(args)
        return _text(f"{name}: {subject}")


# -- helpers -------------------------------------------------------------------------------


def sdk_installed() -> bool:
    try:
        import boxd  # noqa: F401
    except ImportError:
        return False
    return True


def _sdk_client(api_key: str):
    try:
        import boxd
    except ImportError:
        raise ComputerError("The boxd SDK is not installed. Install the backend with its boxd extra (uv sync --extra boxd).", "boxd_sdk_missing") from None
    return boxd.Boxd(api_key=api_key)


def _error_name(exc: BaseException) -> str:
    """The boxd SDK error class (or the nearest one it derives from)."""
    names = [cls.__name__ for cls in type(exc).__mro__]
    for name in ("AuthenticationError", "RegionNotEnabledError", "PermissionDeniedError", "NotFoundError",
                 "ConflictError", "RateLimitError", "APIConnectionError", "APIStatusError", "BoxdError"):
        if name in names:
            return name
    return type(exc).__name__


def _refusal(exc: BaseException, what: str) -> ComputerError:
    name = _error_name(exc)
    if name == "AuthenticationError":
        return ComputerError("The boxd API key was rejected. Update it in the computer settings.", "boxd_auth_failed")
    if name in ("PermissionDeniedError", "RegionNotEnabledError"):
        return ComputerError("The boxd account cannot do this right now. Check its plan, quota and access.", "boxd_plan_restricted")
    if name == "NotFoundError":
        return ComputerError("The boxd machine no longer exists. Remove its record and create a new one.", "boxd_computer_missing")
    if name == "RateLimitError":
        return ComputerError("boxd is rate limiting requests. Try again in a moment.", "boxd_rate_limited")
    if name == "APIConnectionError":
        return ComputerError("Could not reach boxd. Check the connection and try again.", "boxd_unavailable")
    if isinstance(exc, TimeoutError):
        return ComputerError("boxd did not answer in time. Try again.", "boxd_timeout")
    detail = str(exc).strip().splitlines()[0][:300] if str(exc).strip() else name
    return ComputerError(f"boxd could not {what}: {detail}", "boxd_request_failed")


def _file_problem(exc: BaseException) -> str | None:
    """A problem with the path itself, reported to the agent as a tool error."""
    if isinstance(exc, FileNotFoundError):
        return "No such file or folder."
    if isinstance(exc, IsADirectoryError):
        return "That path is a folder; use list_files."
    if isinstance(exc, NotADirectoryError):
        return "A part of that path is not a folder."
    if isinstance(exc, PermissionError):
        return "Permission denied."
    if _error_name(exc) == "BoxdError" and isinstance(exc, OSError):
        return f"The file could not be used: {str(exc)[:300]}"
    return None


def _boxd_file_path(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value or len(value) > 4096:
        raise ComputerError("A valid file path is required.", "invalid_computer_tool")
    raw = value.strip()
    if raw == GUEST_WORKSPACE:
        return _WORKSPACE
    if raw.startswith(GUEST_WORKSPACE + "/"):
        relative = raw[len(GUEST_WORKSPACE) + 1:]
    elif raw.startswith("/"):
        candidate = posixpath.normpath(raw)
        if candidate == _WORKSPACE or candidate.startswith(_WORKSPACE + "/"):
            return candidate
        if candidate != "/tmp" and not candidate.startswith("/tmp/"):
            raise ComputerError("Cloud file tools can access only the computer workspace and /tmp.", "invalid_computer_tool")
        return candidate
    else:
        relative = raw
    normalized = posixpath.normpath(_WORKSPACE + "/" + relative)
    if normalized != _WORKSPACE and not normalized.startswith(_WORKSPACE + "/"):
        raise ComputerError("The file path leaves the computer workspace.", "invalid_computer_tool")
    return normalized


def _boxd_cwd(value: object) -> str:
    if value is None:
        return _WORKSPACE
    if not isinstance(value, str) or "\x00" in value or len(value) > 4096:
        raise ComputerError("Invalid working directory.", "invalid_computer_tool")
    raw = value.strip()
    if raw in ("", ".", GUEST_WORKSPACE):
        return _WORKSPACE
    if raw.startswith(GUEST_WORKSPACE + "/"):
        raw = raw[len(GUEST_WORKSPACE) + 1:]
    elif raw == _WORKSPACE or raw.startswith(_WORKSPACE + "/"):
        raw = raw[len(_WORKSPACE) + 1:]
    normalized = posixpath.normpath(raw or ".")
    if normalized.startswith("/") or normalized == ".." or normalized.startswith("../"):
        raise ComputerError("The working directory must stay under the computer workspace.", "invalid_computer_tool")
    return _WORKSPACE if normalized == "." else f"{_WORKSPACE}/{normalized}"


def _iso(value) -> str | None:
    return value.isoformat() if hasattr(value, "isoformat") else None


def _tail(value: object) -> str:
    text = value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value if isinstance(value, str) else ""
    return text.strip()[-300:] or "no details"


def _clip(value: object) -> str:
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if not isinstance(value, str):
        return ""
    return value[:_MAX_OUTPUT]


def _text(value: str, *, error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": value}], **({"isError": True} if error else {})}
