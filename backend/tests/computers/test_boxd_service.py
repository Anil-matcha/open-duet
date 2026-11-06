"""A boxd computer through ComputerService, with a real database and the fake
boxd client from test_boxd_provider."""

from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import delete

from app.computers.boxd_provider import BOXD_IMAGE, BoxdProvider
from app.computers.provider import ComputerError
from app.computers.service import ComputerService
from app.db.models import Agent, Computer
from app.desktop import boxd_credentials, profile
from tests.computers.test_boxd_provider import KEY, FakeMachines
from tests.services.thread_harness import cleanup, owner, sessions  # noqa: F401


@pytest.fixture
def desktop_profile(tmp_path, monkeypatch):
    key = Fernet.generate_key().decode("ascii")
    monkeypatch.setattr(profile, "_current", profile.DesktopProfile(tmp_path, "http://127.0.0.1:1234", key))
    yield tmp_path


@pytest.fixture
def fake():
    return FakeMachines()


@pytest.fixture
def service(desktop_profile, fake, sessions, owner, tmp_path):  # noqa: F811
    provider = BoxdProvider(client_factory=lambda key: SimpleNamespace(machines=fake))
    return ComputerService(
        providers={"boxd": provider},
        owner_id=owner,
        root=tmp_path / "computers",
        _session_factory=sessions,
    )


@pytest.fixture(autouse=True)
async def computer_cleanup(sessions, owner):  # noqa: F811
    yield
    async with sessions() as db:
        await db.execute(delete(Computer).where(Computer.owner_id == owner))
        await db.execute(delete(Agent).where(Agent.owner_id == owner))
        await db.commit()


@pytest.fixture
async def agent(sessions, owner):  # noqa: F811
    async with sessions() as db:
        row = Agent(owner_id=owner, name="Builder", instructions="")
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row


async def test_a_boxd_computer_needs_a_saved_key(service, agent):
    with pytest.raises(ComputerError) as caught:
        await service.create_for_agent(agent, workspace=None, provider="boxd")
    assert caught.value.code == "boxd_key_missing"


async def test_boxd_resources_and_network_are_managed_by_boxd(service, agent):
    boxd_credentials.get_store().set(KEY)
    for config in ({"cpus": 2}, {"network": "none"}, {"image": "ubuntu"}, {"browser_enabled": True, "kind": "desktop"}):
        with pytest.raises(ValueError):
            await service.create_for_agent(agent, workspace=None, provider="boxd", **config)


async def test_whole_lifecycle_and_a_turn(service, agent, fake):
    boxd_credentials.get_store().set(KEY)
    computer, created = await service.create_for_agent(agent, workspace="/ignored", provider="boxd", kind="desktop")
    assert created and computer.image == BOXD_IMAGE and computer.network == "default" and computer.workspace_path is None

    computer = await service.start(computer.id)
    assert computer.state == "running" and computer.container_id == "id-1"
    assert fake.machines["id-1"].labels["open-dots/computer"] == str(computer.id)

    binding = await service.attach_for_turn(agent.id, 11, None)
    try:
        assert binding.provider == "boxd" and binding.capability_token
        assert "--provider" in binding.launch.args and "boxd" in binding.launch.args
        assert "boxd cloud computer" in binding.prompt_note()
        assert KEY not in binding.prompt_note() and KEY not in " ".join(binding.launch.args)
    finally:
        await service.release_turn(binding, 11)

    computer = await service.stop(computer.id)
    assert computer.state == "stopped" and fake.machines["id-1"].status == "hibernated"
    computer = await service.start(computer.id)
    assert computer.state == "running"

    computer = await service.recreate(computer.id)
    assert computer.state == "running" and computer.container_id == "id-2" and "id-1" not in fake.machines

    assert await service.delete(computer.id) is True
    assert fake.machines == {}
