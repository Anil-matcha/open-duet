"""The boxd provider against a fake boxd client: lifecycle, tools, paths and
errors. No network; the live checks are described in docs/COMPUTERS.md."""

import base64
from dataclasses import replace
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet

from app.computers import boxd_provider
from app.computers.boxd_provider import BoxdProvider, _boxd_cwd, _boxd_file_path
from app.computers.docker_cli import Spec
from app.computers.provider import ComputerError
from app.desktop import boxd_credentials, profile

PNG = b"\x89PNG\r\n\x1a\nsmall-test-image"
KEY = "test-boxd-key-not-a-real-one"
INSTANCE = "a" * 32


# Named like the boxd SDK's errors; the provider classifies errors by name so
# that the SDK can stay an optional, lazily imported dependency.
class BoxdError(Exception):
    pass


class NotFoundError(BoxdError):
    pass


class ConflictError(BoxdError):
    pass


class AuthenticationError(BoxdError):
    pass


class MachineFileNotFoundError(NotFoundError, FileNotFoundError):
    pass


class FakeMachines:
    def __init__(self):
        self.machines: dict[str, SimpleNamespace] = {}
        self.made = 0
        self.calls: list[tuple] = []
        self.exec_results: list[SimpleNamespace] = []
        self.files: dict[str, bytes] = {}
        self.fs = SimpleNamespace(read=self._read, write=self._write, list=self._list)

    def _find(self, key):
        for machine in self.machines.values():
            if key in (machine.id, machine.name):
                return machine
        raise NotFoundError(key)

    def create(self, name, **options):
        self.calls.append(("create", name, options))
        if any(m.name == name for m in self.machines.values()):
            raise ConflictError(f"name {name!r} is already taken")
        self.made += 1
        machine = SimpleNamespace(id=f"id-{self.made}", name=name, status="running",
                                  labels=dict(options.get("labels") or {}), created_at=None)
        self.machines[machine.id] = machine
        return machine

    def get(self, key):
        return self._find(key)

    def delete(self, key):
        self.calls.append(("delete", key))
        del self.machines[self._find(key).id]

    def hibernate(self, key):
        self.calls.append(("hibernate", key))
        self._find(key).status = "hibernated"

    def wake(self, key):
        self.calls.append(("wake", key))
        self._find(key).status = "running"

    def start(self, key):
        self.calls.append(("start", key))
        self._find(key).status = "running"

    def wait_until_ready(self, key, timeout=90.0):
        self.calls.append(("wait", key))
        return self._find(key)

    def exec(self, key, command, **options):
        self._find(key)
        self.calls.append(("exec", key, command, options))
        if self.exec_results:
            return self.exec_results.pop(0)
        return SimpleNamespace(stdout="", stderr="", exit_code=0)

    def _read(self, key, path, *, length=None):
        self.calls.append(("read", path, length))
        if path not in self.files:
            raise MachineFileNotFoundError(path)
        return self.files[path][:length]

    def _write(self, key, path, data):
        self.calls.append(("write", path))
        self.files[path] = data

    def _list(self, key, path):
        self.calls.append(("list", path))
        return [SimpleNamespace(name="b.txt", is_dir=False, size=3), SimpleNamespace(name="a", is_dir=True, size=4096)]


@pytest.fixture
def desktop_profile(tmp_path, monkeypatch):
    key = Fernet.generate_key().decode("ascii")
    monkeypatch.setattr(profile, "_current", profile.DesktopProfile(tmp_path, "http://127.0.0.1:1234", key))
    yield tmp_path


@pytest.fixture
def fake():
    return FakeMachines()


@pytest.fixture
def provider(desktop_profile, fake):
    boxd_credentials.get_store().set(KEY)
    keys = []

    def factory(api_key):
        keys.append(api_key)
        return SimpleNamespace(machines=fake)

    made = BoxdProvider(client_factory=factory)
    made.keys = keys
    return made


def spec(**changes):
    base = Spec(7, INSTANCE, "boxd/default", "", provider_generation="gen-1")
    return replace(base, **changes)


def started(provider, fake, **changes):
    status = provider.create(spec(**changes))
    return spec(container_id=status.container_id, **changes)


def test_health_needs_the_desktop_profile_and_a_saved_key(desktop_profile, monkeypatch):
    provider = BoxdProvider(client_factory=lambda key: None)
    health = provider.health()
    assert health.available is False and "Add a boxd API key" in health.error
    boxd_credentials.get_store().set(KEY)
    assert provider.health().available is True
    monkeypatch.setattr(profile, "_current", None)
    assert "Desktop app" in provider.health().error


def test_key_is_stored_apart_from_the_boat_key(desktop_profile):
    from app.desktop import boat_credentials

    boxd_credentials.get_store().set(KEY)
    assert (desktop_profile / boxd_credentials.FILE_NAME).exists()
    assert KEY.encode() not in (desktop_profile / boxd_credentials.FILE_NAME).read_bytes()
    assert boat_credentials.get_store().get() is None
    assert boxd_credentials.get_store().get() == KEY


def test_missing_key_is_a_clear_error(desktop_profile, fake):
    provider = BoxdProvider(client_factory=lambda key: SimpleNamespace(machines=fake))
    with pytest.raises(ComputerError) as caught:
        provider.create(spec())
    assert caught.value.code == "boxd_key_missing"
    assert fake.calls == []


def test_create_labels_the_machine_and_only_uses_the_saved_key(provider, fake):
    status = provider.create(spec())
    assert status.state == "creating" and status.container_id == "id-1"
    _, name, options = fake.calls[0]
    assert name == spec().name
    assert options == {"labels": {"open-dots/instance": INSTANCE, "open-dots/computer": "7", "open-dots/generation": "gen-1"}}
    assert provider.keys == [KEY]


def test_name_prefix_labels_and_delete_after_are_passed_through(desktop_profile, fake):
    boxd_credentials.get_store().set(KEY)
    provider = BoxdProvider(client_factory=lambda key: SimpleNamespace(machines=fake),
                            name_prefix="t-test-", labels={"team": "qa"}, delete_after=3600)
    provider.create(spec())
    _, name, options = fake.calls[0]
    assert name == "t-test-7"
    assert options["delete_after"] == 3600 and options["labels"]["team"] == "qa"


def test_start_prepares_the_workspace_and_reports_running(provider, fake):
    current = started(provider, fake)
    status = provider.start(current)
    assert status.state == "running" and status.desktop_ready is False
    _, _, command, _ = [c for c in fake.calls if c[0] == "exec"][0]
    assert command == ["bash", "-c", "mkdir -p /home/boxd/workspace"]


def test_desktop_start_also_starts_its_display(provider, fake):
    current = started(provider, fake, kind="desktop")
    assert provider.start(current).desktop_ready is True
    _, _, command, _ = [c for c in fake.calls if c[0] == "exec"][0]
    assert "Xvfb :99 -screen 0 1280x800x24" in command[2]


def test_an_interrupted_create_is_resumed_and_a_stranger_is_refused(provider, fake):
    first = provider.create(spec())
    again = provider.create(spec())  # the id was never saved: same name, same generation
    assert again.container_id == first.container_id
    with pytest.raises(ComputerError) as caught:
        provider.create(spec(provider_generation="gen-2"))
    assert caught.value.code == "boxd_name_taken"
    fake.machines["id-1"].labels = {}
    with pytest.raises(ComputerError) as caught:
        provider.create(spec())
    assert caught.value.code == "boxd_name_taken"


def test_status_maps_machine_states(provider, fake):
    current = started(provider, fake)
    machine = fake.machines["id-1"]
    for raw, expected in [("running", "running"), ("suspended", "running"), ("hibernated", "stopped"),
                          ("stopped", "stopped"), ("starting", "creating"), ("failed", "unavailable")]:
        machine.status = raw
        assert provider.status(current).state == expected
    machine.labels = {"open-dots/instance": "b" * 32, "open-dots/computer": "7"}
    assert provider.status(current).state == "foreign"
    del fake.machines["id-1"]
    assert provider.status(current).state == "missing"
    assert provider.status(spec()).state == "missing"


def test_stop_hibernates_and_start_wakes(provider, fake):
    current = started(provider, fake)
    assert provider.stop(current).state == "stopped"
    assert ("hibernate", "id-1") in fake.calls
    assert provider.stop(current).state == "stopped"  # already asleep: no second call
    assert [c for c in fake.calls if c[0] == "hibernate"] == [("hibernate", "id-1")]
    assert provider.start(current).state == "running"
    assert ("wake", "id-1") in fake.calls
    fake.machines["id-1"].status = "stopped"
    provider.start(current)
    assert ("start", "id-1") in fake.calls


def test_a_vanished_machine_is_made_again(provider, fake):
    current = started(provider, fake)
    del fake.machines["id-1"]
    status = provider.create(current)
    assert status.state == "creating" and status.container_id == "id-2"


def test_delete_is_synchronous_and_refuses_foreign_machines(provider, fake):
    current = started(provider, fake)
    assert provider.delete(current) is None
    assert fake.machines == {}
    assert provider.delete(current) is None  # already gone
    current = started(provider, fake)
    fake.machines[current.container_id].labels = {}
    with pytest.raises(ComputerError) as caught:
        provider.delete(current)
    assert caught.value.code == "computer_foreign"
    assert current.container_id in fake.machines


def test_exec_runs_under_a_time_limit_in_the_workspace(provider, fake):
    current = started(provider, fake)
    fake.exec_results.append(SimpleNamespace(stdout="hello\n", stderr="warn\n", exit_code=3))
    result = provider.tool(current, "exec", {"command": "echo hello", "cwd": "/workspace/src", "timeout_seconds": 5})
    _, _, argv, options = fake.calls[-1]
    assert argv == ["timeout", "-k", "5", "5", "bash", "-c", "echo hello"]
    assert options == {"timeout": 35, "cwd": "/home/boxd/workspace/src"}
    text = result["content"][0]["text"]
    assert text.startswith("exit code: 3") and "hello" in text and "warn" in text
    assert result["isError"] is True


def test_exec_on_a_desktop_gets_the_display_and_timeouts_are_reported(provider, fake):
    current = started(provider, fake, kind="desktop")
    fake.exec_results.append(SimpleNamespace(stdout="", stderr="", exit_code=124))
    result = provider.tool(current, "exec", {"command": "sleep 100", "timeout_seconds": 1})
    assert fake.calls[-1][3]["env"] == {"DISPLAY": ":99"}
    assert "(timed out)" in result["content"][0]["text"]


def test_files_go_through_the_file_api(provider, fake):
    current = started(provider, fake)
    wrote = provider.tool(current, "write_file", {"path": "notes/a.txt", "content": "hi"})
    assert wrote["content"][0]["text"] == "Wrote 2 bytes to notes/a.txt."
    assert fake.files["/home/boxd/workspace/notes/a.txt"] == b"hi"
    read = provider.tool(current, "read_file", {"path": "/workspace/notes/a.txt"})
    assert read["content"][0]["text"] == "hi"
    assert fake.calls[-1] == ("read", "/home/boxd/workspace/notes/a.txt", 2_000_001)
    missing = provider.tool(current, "read_file", {"path": "nope.txt"})
    assert missing["isError"] is True and "No such file" in missing["content"][0]["text"]
    fake.files["/tmp/bin"] = b"a\x00b"
    assert provider.tool(current, "read_file", {"path": "/tmp/bin"})["isError"] is True
    listed = provider.tool(current, "list_files", {})
    assert listed["content"][0]["text"] == "a/  0 bytes\nb.txt  3 bytes"


@pytest.mark.parametrize("path, expected", [
    ("/workspace", "/home/boxd/workspace"),
    ("a/../b.txt", "/home/boxd/workspace/b.txt"),
    ("/workspace/x/y", "/home/boxd/workspace/x/y"),
    ("/home/boxd/workspace/z", "/home/boxd/workspace/z"),
    ("/tmp/x", "/tmp/x"),
])
def test_file_paths_map_into_the_workspace(path, expected):
    assert _boxd_file_path(path) == expected


@pytest.mark.parametrize("path", ["../etc/passwd", "/etc/passwd", "/tmp/../etc/passwd", "", "a\x00b", "/home/boxd/.ssh/id"])
def test_file_paths_cannot_leave_the_workspace_or_tmp(path):
    with pytest.raises(ComputerError):
        _boxd_file_path(path)


def test_working_directories_stay_in_the_workspace():
    assert _boxd_cwd(None) == "/home/boxd/workspace"
    assert _boxd_cwd("src") == "/home/boxd/workspace/src"
    for bad in ("/etc", "..", "../x"):
        with pytest.raises(ComputerError):
            _boxd_cwd(bad)


def test_screenshot_captures_the_display_as_bytes(provider, fake):
    current = started(provider, fake, kind="desktop")
    fake.exec_results.append(SimpleNamespace(stdout=PNG, stderr=b"", exit_code=0))
    assert provider.screenshot(current) == PNG
    _, _, argv, options = fake.calls[-1]
    assert options["encoding"] == "buffer" and options["env"] == {"DISPLAY": ":99"}
    assert argv[-1].endswith("import -window root png:-")


def test_screen_tools_crop_and_drive_xdotool(provider, fake):
    current = started(provider, fake, kind="desktop")
    fake.exec_results.append(SimpleNamespace(stdout=PNG, stderr=b"", exit_code=0))
    shot = provider.tool(current, "screenshot", {"x": 2, "y": 3, "width": 100, "height": 80})
    assert shot["content"][1]["data"] == base64.b64encode(PNG).decode("ascii")
    assert "-crop 100x80+2+3 +repage" in fake.calls[-1][2][-1]
    clicked = provider.tool(current, "click", {"x": 10, "y": 20})
    assert "xdotool mousemove --sync 10 20 click" in fake.calls[-1][2][-1]
    assert clicked["content"][0]["text"].startswith("click:")
    fake.exec_results.append(SimpleNamespace(stdout="", stderr="no display", exit_code=1))
    with pytest.raises(ComputerError) as caught:
        provider.tool(current, "key", {"keys": "Return"})
    assert caught.value.code == "boxd_screen_failed"


def test_screen_tools_need_a_desktop(provider, fake):
    current = started(provider, fake)
    with pytest.raises(ComputerError) as caught:
        provider.tool(current, "screenshot", {})
    assert caught.value.code == "not_a_desktop"


def test_failed_capture_fails_closed(provider, fake):
    current = started(provider, fake, kind="desktop")
    fake.exec_results.append(SimpleNamespace(stdout=b"not a png", stderr=b"", exit_code=0))
    with pytest.raises(ComputerError) as caught:
        provider.screenshot(current)
    assert caught.value.code == "desktop_not_ready"


def test_sdk_errors_become_clear_computer_errors(desktop_profile):
    boxd_credentials.get_store().set(KEY)

    def rejected(key):
        machines = SimpleNamespace(create=lambda *a, **k: (_ for _ in ()).throw(AuthenticationError("API key not recognized")))
        return SimpleNamespace(machines=machines)

    with pytest.raises(ComputerError) as caught:
        BoxdProvider(client_factory=rejected).create(spec())
    assert caught.value.code == "boxd_auth_failed"
    assert KEY not in str(caught.value)


def test_the_sdk_is_optional(desktop_profile, monkeypatch):
    boxd_credentials.get_store().set(KEY)
    monkeypatch.setattr(boxd_provider, "sdk_installed", lambda: False)
    health = BoxdProvider().health()
    assert health.available is False and "uv sync --extra boxd" in health.error


def test_mcp_launch_points_the_child_at_the_local_bridge(provider, tmp_path):
    from app.desktop import computer_capabilities

    launch, token = provider.mcp_launch_for_turn(spec(container_id="id-1"), tmp_path / "grants", tmp_path / "state", 42)
    try:
        args = launch.args
        assert args[args.index("--provider") + 1] == "boxd"
        assert args[args.index("--turn-id") + 1] == "42"
        assert KEY not in " ".join(args) and KEY not in str(launch.env)
    finally:
        computer_capabilities.revoke(token)
