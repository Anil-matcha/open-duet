"""The Cheaper Inference preset of the OpenAI-compatible engine, against a fake
endpoint (httpx MockTransport; nothing reaches cheaperinference.com): its
default address, required key and its own saved configuration."""

import json

import httpx
import pytest
from sqlalchemy import delete

from app.core.config import settings
from app.db.models import Agent
from app.db.models.user_credential import UserCredential
from app.services import engine_config, local_claude_runner
from app.services.openai_chat_adapter import (
    CHEAPER_INFERENCE_BASE_URL,
    CheaperInferenceAdapter,
    InvalidConfig,
    OpenAIChatAdapter,
)
from app.services.thread_hub import ThreadHub
from app.services.thread_runtime import ProviderUnavailable, ThreadRuntime
from tests.services.test_openai_chat_adapter import Endpoint, data_of
from tests.services.thread_harness import cleanup, events_of, finished, owner, sessions  # noqa: F401

KEY = "ci_live_FAKE_0123456789abcdef"
MODEL = "gpt-5.4-mini"


@pytest.fixture
def endpoint():
    return Endpoint()


@pytest.fixture
async def cia(sessions, owner, monkeypatch, endpoint, tmp_path):
    monkeypatch.setattr(settings, "LOCAL_TOOLS_ENABLED", False)
    monkeypatch.setattr(settings, "THREAD_HEARTBEAT_SECONDS", 0.2)
    monkeypatch.setattr(local_claude_runner, "workspace_dir", lambda: tmp_path)
    runtime = ThreadRuntime(
        hub=ThreadHub(),
        adapters={
            "openai_compat": OpenAIChatAdapter(transport=httpx.MockTransport(endpoint)),
            "cheaperinference": CheaperInferenceAdapter(transport=httpx.MockTransport(endpoint)),
        },
        status_ttl=0, _session_factory=sessions, owner_id=owner,
    )
    yield runtime
    await runtime.shutdown()
    async with sessions() as db:
        await db.execute(delete(Agent).where(Agent.owner_id == owner))
        await db.execute(delete(UserCredential).where(UserCredential.user_id == owner))
        await db.commit()


def test_config_defaults_the_address_and_requires_a_key():
    adapter = CheaperInferenceAdapter()
    saved = adapter.validate_config({"api_key": KEY, "model": MODEL}, None)
    assert saved == {"base_url": CHEAPER_INFERENCE_BASE_URL, "model": MODEL, "api_key": KEY}
    assert adapter.validate_config({}, saved)["api_key"] == KEY
    assert adapter.public_config(saved) == {"base_url": CHEAPER_INFERENCE_BASE_URL, "model": MODEL, "has_api_key": True}
    for payload in ({}, {"api_key": "  "}, {"base_url": "https://proxy.test/v1", "api_key": KEY}, {"clear_api_key": True}):
        with pytest.raises(InvalidConfig):
            adapter.validate_config(payload, None)


async def test_without_a_key_it_is_not_ready_and_sends_nothing(endpoint):
    adapter = CheaperInferenceAdapter(transport=httpx.MockTransport(endpoint))
    for config in (None, {"base_url": CHEAPER_INFERENCE_BASE_URL}):
        adapter.config = config
        status, probe = await adapter.status(), await adapter.probe()
        assert not status.ready and "Cheaper Inference API key" in status.error
        assert not probe.ready and "Cheaper Inference API key" in probe.reason
    assert endpoint.requests == []


async def test_probe_lists_the_catalog_with_the_key(endpoint):
    endpoint.handler = lambda r: httpx.Response(200, json={"data": [{"id": "gpt-5.4"}, {"id": MODEL}]})
    adapter = CheaperInferenceAdapter(transport=httpx.MockTransport(endpoint))
    adapter.config = {"base_url": CHEAPER_INFERENCE_BASE_URL, "api_key": KEY, "model": MODEL}
    probe = await adapter.probe()
    assert probe.ready and probe.signed_in is True
    assert [(m.id, m.default) for m in probe.models] == [("gpt-5.4", False), (MODEL, True)]
    request = endpoint.requests[0]
    assert str(request.url) == "https://api.cheaperinference.com/v1/models"
    assert request.headers["authorization"] == f"Bearer {KEY}"


async def test_a_turn_goes_to_cheaper_inference_with_its_own_saved_config(cia, sessions, owner, endpoint):
    async with sessions() as db:
        await engine_config.save(db, owner, "cheaperinference", CheaperInferenceAdapter().validate_config({"api_key": KEY}, None))
        await engine_config.save(db, owner, "openai_compat", {"base_url": "http://llm.test/v1", "model": "local"})
    thread = await cia.create_thread(provider="cheaperinference", model=MODEL)
    await cia.send_turn(thread.id, "hi")
    await finished(sessions, thread.id)
    events = await events_of(sessions, thread.id)
    assert data_of(events, "assistant.message") == [{"text": "Hello"}]
    request = next(r for r in endpoint.requests if r.method == "POST")
    assert str(request.url) == "https://api.cheaperinference.com/v1/chat/completions"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert json.loads(request.content)["model"] == MODEL
    # The plain OpenAI-compatible engine keeps its own address and key.
    other = await cia.create_thread(provider="openai_compat")
    await cia.send_turn(other.id, "hi")
    await finished(sessions, other.id)
    local = endpoint.requests[-1]
    assert str(local.url) == "http://llm.test/v1/chat/completions"
    assert "authorization" not in local.headers


async def test_a_turn_without_a_saved_key_is_refused(cia, sessions, owner, endpoint):
    thread = await cia.create_thread(provider="cheaperinference", model=MODEL)
    with pytest.raises(ProviderUnavailable, match="Cheaper Inference API key"):
        await cia.send_turn(thread.id, "hi")
    assert endpoint.requests == []
