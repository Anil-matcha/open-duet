"""Desktop account proxy tests: no live cloud calls are made."""

import json

import httpx
import pytest
from cryptography.fernet import Fernet

from app.desktop import account, profile


@pytest.fixture
def manager(tmp_path):
    profile._current = profile.DesktopProfile(tmp_path, "http://127.0.0.1:1234", Fernet.generate_key().decode())
    transport = httpx.MockTransport(lambda request: httpx.Response(500))
    client = httpx.AsyncClient(transport=transport)
    instance = account.AccountManager(client=client)
    yield instance, client
    profile._current = None


@pytest.mark.asyncio
async def test_verified_session_is_encrypted_restored_and_never_returned(manager):
    instance, client = manager
    async def handler(request):
        assert request.url.host == "suparagent.ai"
        assert request.url.path.endswith("/email/verify")
        return httpx.Response(200, json={"token": "secret-device-token", "expires_at": "2030-01-01T00:00:00Z",
                                         "user": {"email": "person@example.org", "tenantId": "tenant-1"}})
    client._transport = httpx.MockTransport(handler)
    result = await instance.email_verify("person@example.org", "123456", True)
    assert "secret-device-token" not in json.dumps(result)
    raw = (instance.data_dir / account.SESSION_FILE).read_bytes()
    assert b"secret-device-token" not in raw
    assert (instance.data_dir / account.SESSION_FILE).stat().st_mode & 0o777 == 0o600

    async def session_handler(request):
        assert request.headers["authorization"] == "Bearer secret-device-token"
        return httpx.Response(200, json={"user": {"email": "person@example.org", "tenantId": "tenant-1"}})
    client._transport = httpx.MockTransport(session_handler)
    profile._current = profile.DesktopProfile(instance.data_dir, "http://127.0.0.1:1234", profile._current.encryption_key)
    restored = account.AccountManager(client=client)
    assert (await restored.status())["signed_in"] is True


@pytest.mark.asyncio
async def test_tenant_mismatch_clears_session_and_rejects_binding(manager):
    instance, client = manager
    instance._write_secret(instance._binding_path, {"tenant_id": "tenant-old", "email": "old@example.org"})
    instance._write_secret(instance._session_path, {"token": "device-token", "expires_at": "2099-01-01T00:00:00Z"})
    client._transport = httpx.MockTransport(lambda request: httpx.Response(200, json={
        "user": {"email": "new@example.org", "tenantId": "tenant-new"}}))
    result = await instance.status()
    assert result["signed_in"] is False
    assert instance._token() is None
    assert instance._read_secret(instance._binding_path)["tenant_id"] == "tenant-old"


@pytest.mark.asyncio
async def test_bound_profile_can_reauthenticate_same_tenant_without_new_adoption(manager):
    instance, client = manager
    instance._write_secret(instance._binding_path, {"tenant_id": "tenant-1", "email": "old@example.org"})
    client._transport = httpx.MockTransport(lambda request: httpx.Response(200, json={
        "token": "same-tenant-token", "expires_at": "2030-01-01T00:00:00Z",
        "user": {"email": "new@example.org", "tenantId": "tenant-1"}}))
    result = await instance.email_verify("new@example.org", "123456", False)
    assert result["signed_in"] is True
    assert instance._read_secret(instance._binding_path)["tenant_id"] == "tenant-1"


@pytest.mark.asyncio
async def test_new_session_for_different_tenant_is_revoked_and_not_stored(manager):
    instance, client = manager
    instance._write_secret(instance._binding_path, {"tenant_id": "tenant-old", "email": "old@example.org"})
    revoked = []
    async def handler(request):
        if request.url.path.endswith("/email/verify"):
            return httpx.Response(200, json={"token": "wrong-tenant-token", "expires_at": "2030-01-01T00:00:00Z",
                                             "user": {"email": "new@example.org", "tenantId": "tenant-new"}})
        revoked.append(request.headers.get("authorization"))
        return httpx.Response(200)
    client._transport = httpx.MockTransport(handler)
    with pytest.raises(account.DesktopAccountError) as exc:
        await instance.email_verify("new@example.org", "123456", False)
    assert exc.value.code == "profile_account_mismatch"
    assert revoked == ["Bearer wrong-tenant-token"]
    assert instance._read_secret(instance._binding_path)["tenant_id"] == "tenant-old"
    assert instance._token() is None


@pytest.mark.asyncio
async def test_corrupt_binding_fails_closed_instead_of_being_replaced(manager):
    instance, client = manager
    instance._binding_path.write_bytes(b"not an encrypted profile record")
    client._transport = httpx.MockTransport(lambda request: httpx.Response(200, json={
        "token": "secret", "expires_at": "2030-01-01T00:00:00Z",
        "user": {"email": "person@example.org", "tenantId": "tenant-1"}}))
    with pytest.raises(account.DesktopAccountError) as exc:
        await instance.email_verify("person@example.org", "123456", True)
    assert exc.value.code == "profile_storage_error"
    assert instance._binding_path.read_bytes() == b"not an encrypted profile record"
    assert not instance._session_path.exists()


@pytest.mark.asyncio
async def test_verify_requires_explicit_adoption_and_server_errors_are_redacted(manager):
    instance, client = manager
    with pytest.raises(account.DesktopAccountError) as exc:
        await instance.email_verify("p@example.org", "123456", False)
    assert exc.value.code == "local_data_adoption_required"
    client._transport = httpx.MockTransport(lambda request: httpx.Response(500, text="private stack trace"))
    with pytest.raises(account.DesktopAccountError) as exc:
        await instance.email_start("p@example.org")
    assert exc.value.code == "account_service_unavailable"
    assert "private stack trace" not in str(exc.value)


@pytest.mark.asyncio
async def test_remote_unauthorized_removes_saved_session(manager):
    instance, client = manager
    instance._write_secret(instance._session_path, {"token": "device-token", "expires_at": "2099-01-01T00:00:00Z"})
    client._transport = httpx.MockTransport(lambda request: httpx.Response(401))
    result = await instance.status()
    assert result["signed_in"] is False
    assert instance._token() is None
