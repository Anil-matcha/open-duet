"""A hosted deployment can plug in a principal resolver and public routes without editing the
middleware; with nothing registered the single-owner behavior is untouched."""

import httpx
import pytest
from fastapi import FastAPI, Request

from app.auth import policy, tenancy
from app.auth.middleware import AuthMiddleware, principal_of
from app.core.config import settings

HOST = "dots.example.com"


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.setattr(settings, "TRUSTED_HOSTS", f"localhost,{HOST}")
    monkeypatch.setattr(settings, "LOOPBACK_TRUST", "off")
    monkeypatch.setattr(policy, "PUBLIC_ROUTES", policy.PUBLIC_ROUTES)
    yield
    tenancy.register_principal_resolver(None)


def build() -> httpx.AsyncClient:
    app = FastAPI()

    @app.get("/api/v1/agents")  # chat-scoped route
    async def agents(request: Request):
        return {"tenant": principal_of(request.scope).tenant_id}

    @app.get("/api/v1/settings")  # admin-only route
    async def settings_route():
        return {}

    @app.post("/api/v1/accounts/signup")
    async def signup():
        return {"ok": True}

    app.add_middleware(AuthMiddleware, session_factory=None)
    transport = httpx.ASGITransport(app, client=("203.0.113.7", 1))
    return httpx.AsyncClient(transport=transport, base_url=f"http://{HOST}")


@pytest.mark.asyncio
async def test_resolver_supplies_the_tenant():
    async def resolve(scope):
        return policy.Principal(kind="account", scopes=("admin", "chat"), tenant_id="u_1")

    tenancy.register_principal_resolver(resolve)
    async with build() as api:
        response = await api.get("/api/v1/agents")
    assert response.status_code == 200 and response.json() == {"tenant": "u_1"}


@pytest.mark.asyncio
async def test_no_credential_is_refused_and_never_falls_back_to_the_owner():
    async def resolve(scope):
        return None

    tenancy.register_principal_resolver(resolve)
    async with build() as api:
        response = await api.get("/api/v1/agents")
    assert response.status_code == 401
    assert response.json()["detail"]["error_code"] == "auth_required"


@pytest.mark.asyncio
async def test_scopes_are_enforced_for_resolved_principals():
    async def resolve(scope):
        return policy.Principal(kind="account", scopes=("chat",), tenant_id="u_1")

    tenancy.register_principal_resolver(resolve)
    async with build() as api:
        assert (await api.get("/api/v1/agents")).status_code == 200
        denied = await api.get("/api/v1/settings")
    assert denied.status_code == 403


@pytest.mark.asyncio
async def test_registered_public_route_needs_no_session():
    tenancy.register_public_route({"POST"}, r"/api/v1/accounts/signup")
    async with build() as api:
        response = await api.post("/api/v1/accounts/signup")
    assert response.status_code == 200
