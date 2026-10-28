"""Desktop account session proxy and profile-bound session storage.

The renderer talks only to the local API. Cloud credentials are kept encrypted in
the profile and are never included in a renderer response.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from cryptography.fernet import Fernet, MultiFernet, InvalidToken

from app.desktop import profile

CLOUD_DESKTOP_URL = "https://suparagent.ai/api/v1/accounts/desktop"
SESSION_FILE = "account-session.enc"
BINDING_FILE = "account-binding.enc"
SESSION_CACHE_SECONDS = 60


class DesktopAccountError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


class AccountManager:
    def __init__(self, *, client: httpx.AsyncClient | None = None, base_url: str = CLOUD_DESKTOP_URL):
        current = profile.current()
        if current is None:
            raise RuntimeError("Desktop profile is not active.")
        self.data_dir = current.data_dir
        self._cipher = MultiFernet([
            Fernet(key.strip().encode("ascii"))
            for key in current.encryption_key.split(",") if key.strip()
        ])
        self._base_url = base_url
        self._client = client
        self._cache_until = 0.0
        self._cached_user: dict[str, str] | None = None
        self._account_lock = asyncio.Lock()

    @property
    def _session_path(self) -> Path:
        return self.data_dir / SESSION_FILE

    @property
    def _binding_path(self) -> Path:
        return self.data_dir / BINDING_FILE

    def _read_secret(self, path: Path) -> dict[str, Any] | None:
        try:
            payload = self._cipher.decrypt(path.read_bytes())
            value = json.loads(payload)
            if not isinstance(value, dict):
                raise ValueError("invalid encrypted profile record")
            return value
        except FileNotFoundError:
            return None
        except (InvalidToken, ValueError, OSError, json.JSONDecodeError):
            raise DesktopAccountError(503, "profile_storage_error") from None

    def _write_secret(self, path: Path, value: dict[str, Any]) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        encrypted = self._cipher.encrypt(json.dumps(value, separators=(",", ":")).encode())
        fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=self.data_dir)
        try:
            if os.name != "nt":
                os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(encrypted)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, path)
            os.chmod(path, 0o600)
        finally:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass

    def _clear_session(self) -> None:
        try:
            self._session_path.unlink()
        except FileNotFoundError:
            pass
        self._cached_user = None
        self._cache_until = 0

    def _token(self) -> str | None:
        stored = self._read_secret(self._session_path)
        token = stored.get("token") if stored else None
        if stored and not isinstance(stored.get("expires_at"), str):
            raise DesktopAccountError(503, "profile_storage_error")
        return token if isinstance(token, str) and token else None

    @staticmethod
    def _expiry_epoch(value: str) -> float:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.timestamp()
        except (TypeError, ValueError, OverflowError):
            raise DesktopAccountError(503, "profile_storage_error") from None

    async def _request(self, method: str, suffix: str = "", *, token: str | None = None,
                       json_body: dict[str, Any] | None = None) -> httpx.Response:
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        url = f"{self._base_url}{suffix}"
        if self._client is not None:
            return await self._client.request(method, url, headers=headers, json=json_body, follow_redirects=False)
        async with httpx.AsyncClient(timeout=10.0, verify=True, follow_redirects=False) as client:
            return await client.request(method, url, headers=headers, json=json_body)

    @staticmethod
    def _remote_error(response: httpx.Response) -> DesktopAccountError:
        # Never forward remote detail bodies (they may contain private data).
        if response.status_code == 429:
            return DesktopAccountError(429, "rate_limited")
        if response.status_code in (400, 401, 403, 409, 422):
            return DesktopAccountError(response.status_code, "account_request_rejected")
        return DesktopAccountError(503, "account_service_unavailable")

    def profile_bound(self) -> bool:
        binding = self._read_secret(self._binding_path)
        return bool(binding and isinstance(binding.get("tenant_id"), str))

    async def status(self) -> dict[str, Any]:
        token = self._token()
        if not token:
            return {"signed_in": False, "email": None, "tenantId": None,
                    "account_required": True, "profile_bound": self.profile_bound()}
        if self._cached_user and time.monotonic() < self._cache_until:
            return {"signed_in": True, **self._cached_user, "account_required": True,
                    "profile_bound": self.profile_bound()}
        stored = self._read_secret(self._session_path)
        if stored and self._expiry_epoch(stored["expires_at"]) <= time.time():
            self._clear_session()
            return {"signed_in": False, "email": None, "tenantId": None,
                    "account_required": True, "profile_bound": self.profile_bound()}
        try:
            response = await self._request("GET", "/session", token=token)
        except httpx.HTTPError:
            raise DesktopAccountError(503, "account_service_unavailable") from None
        if response.status_code == 401:
            self._clear_session()
            return {"signed_in": False, "email": None, "tenantId": None,
                    "account_required": True, "profile_bound": self.profile_bound()}
        if response.status_code != 200:
            raise DesktopAccountError(503, "account_service_unavailable")
        try:
            user = response.json()["user"]
            email, tenant_id = user["email"], user["tenantId"]
        except (ValueError, KeyError, TypeError):
            raise DesktopAccountError(503, "account_service_unavailable") from None
        if (not isinstance(email, str) or "@" not in email or len(email) > 254
                or not isinstance(tenant_id, str) or not tenant_id or len(tenant_id) > 64):
            raise DesktopAccountError(503, "account_service_unavailable")
        binding = self._read_secret(self._binding_path)
        if binding and binding.get("tenant_id") != tenant_id:
            self._clear_session()
            return {"signed_in": False, "email": None, "tenantId": None,
                    "account_required": True, "profile_bound": True}
        if not binding:
            self._write_secret(self._binding_path, {"tenant_id": tenant_id, "email": email})
        self._cached_user = {"email": email, "tenantId": tenant_id}
        session = self._read_secret(self._session_path)
        expires_epoch = self._expiry_epoch(session["expires_at"]) if session else time.time()
        self._cache_until = time.monotonic() + min(SESSION_CACHE_SECONDS, max(0, expires_epoch - time.time()))
        return {"signed_in": True, **self._cached_user, "account_required": True,
                "profile_bound": self.profile_bound()}

    async def email_start(self, email: str, invite_code: str | None = None) -> dict[str, str]:
        body = {"email": email}
        if invite_code is not None:
            body["invite_code"] = invite_code
        try:
            response = await self._request("POST", "/email/start", json_body=body)
        except httpx.HTTPError:
            raise DesktopAccountError(503, "account_service_unavailable") from None
        if response.status_code not in (200, 202):
            raise self._remote_error(response)
        return {"status": "if_account_exists_code_sent"}

    async def email_verify(self, email: str, code: str, adopt_local_data: bool) -> dict[str, Any]:
        async with self._account_lock:
            binding = self._read_secret(self._binding_path)
            if not isinstance(adopt_local_data, bool):
                raise DesktopAccountError(400, "invalid_request")
            if not binding and not adopt_local_data:
                raise DesktopAccountError(400, "local_data_adoption_required")
            try:
                response = await self._request("POST", "/email/verify", json_body={"email": email, "code": code})
            except httpx.HTTPError:
                raise DesktopAccountError(503, "account_service_unavailable") from None
            if response.status_code not in (200, 201):
                raise self._remote_error(response)
            try:
                payload = response.json()
                token = payload["token"]
                user = payload["user"]
                email_value, tenant_id = user["email"], user["tenantId"]
                expires_at = payload["expires_at"]
                if not all(isinstance(v, str) and v for v in (token, email_value, tenant_id, expires_at)):
                    raise ValueError
                expires_epoch = self._expiry_epoch(expires_at)
                if expires_epoch <= time.time() or "@" not in email_value or len(email_value) > 254 or len(tenant_id) > 64:
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                raise DesktopAccountError(503, "account_service_unavailable") from None
            if binding and binding.get("tenant_id") != tenant_id:
                try:
                    await self._request("POST", "/logout", token=token)
                except httpx.HTTPError:
                    pass
                raise DesktopAccountError(409, "profile_account_mismatch")
            # Bind first: a crash after this write must never leave adopted local data
            # available to an unbound account on the next launch.
            if not binding:
                self._write_secret(self._binding_path, {"tenant_id": tenant_id, "email": email_value})
            self._write_secret(self._session_path, {"token": token, "expires_at": expires_at})
            self._cached_user = {"email": email_value, "tenantId": tenant_id}
            self._cache_until = time.monotonic() + min(SESSION_CACHE_SECONDS, expires_epoch - time.time())
            return {"signed_in": True, "email": email_value, "tenantId": tenant_id,
                    "account_required": True, "profile_bound": True}

    async def logout(self) -> dict[str, Any]:
        async with self._account_lock:
            token = self._token()
            remote_signed_out = True
            if token:
                try:
                    response = await self._request("POST", "/logout", token=token)
                    remote_signed_out = response.status_code in (200, 204, 401)
                except httpx.HTTPError:
                    remote_signed_out = False
            self._clear_session()
            return {"signed_in": False, "remote_signed_out": remote_signed_out,
                    "profile_bound": self.profile_bound()}

    async def require_account(self) -> dict[str, str]:
        state = await self.status()
        if not state["signed_in"]:
            raise DesktopAccountError(401, "account_sign_in_required")
        return {"email": state["email"], "tenantId": state["tenantId"]}


_manager: AccountManager | None = None


def get_manager() -> AccountManager:
    global _manager
    if _manager is None:
        _manager = AccountManager()
    return _manager
