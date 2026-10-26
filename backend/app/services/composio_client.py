"""Composio's REST API (v3.1), called with the owner's own project key.

Only what Settings needs: a Tool Router session, a connect link, the
connected accounts of this installation's one Composio user, and removing an
account. The key and the raw Composio responses stay in this module:

- A connected-account item carries the app's OAuth access token (`data`,
  `state`). `_account` copies the few fields the app shows and nothing else.
- Errors carry Composio's short message, never the request or the key.
- A connect link is accepted only when it is https on composio.dev.

Verified live in the Phase 0 spike (.internal/design/composio-integration.md
section 9.0): session create, link, account listing. Not verified live: the
`revoke_on_delete` parameter of account removal and the 600 second link life.
"""

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

BASE_URL = "https://backend.composio.dev/api/v3.1"
LINK_LIFETIME_SECONDS = 600
MAX_RESPONSE_BYTES = 2_000_000
TIMEOUT_SECONDS = 20.0
PAGE_LIMIT = 100
MAX_PAGES = 5
MAX_MESSAGE = 200

EXECUTE_TIMEOUT_SECONDS = 60.0

_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SLUG = re.compile(r"^[A-Z0-9_]{1,120}$")


class ComposioError(Exception):
    """`kind` says what the app should do about it:
    key_rejected (the key is wrong or lacks permission), not_found,
    rate_limited, unavailable (network or Composio down), rejected (the
    request was refused), bad_response (an answer we will not trust)."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


@dataclass(frozen=True)
class Account:
    id: str
    toolkit: str
    alias: str | None
    status: str
    created_at: str | None
    updated_at: str | None


@dataclass(frozen=True)
class Execution:
    result_type: str   # completed | failed | blocked | anything else Composio adds
    data: object
    error: str | None


@dataclass(frozen=True)
class Link:
    redirect_url: str
    account_id: str


def trusted_link(raw: object) -> str | None:
    """The connect link when it is https on composio.dev (or a subdomain,
    as `connect.composio.dev` is), else None."""
    if not isinstance(raw, str) or len(raw) > 4096:
        return None
    try:
        parts = urlsplit(raw)
        host = parts.hostname or ""
    except ValueError:
        return None
    if parts.scheme != "https" or parts.username or parts.password or parts.port not in (None, 443):
        return None
    return raw if host == "composio.dev" or host.endswith(".composio.dev") else None


def _text(value: object, limit: int = MAX_MESSAGE) -> str | None:
    return value[:limit] if isinstance(value, str) and value else None


def _account(item: object) -> Account | None:
    """One account, reduced to display fields. Anything else in `item`
    (the access token above all) is dropped here."""
    if not isinstance(item, dict):
        return None
    identifier = item.get("id")
    toolkit = (item.get("toolkit") or {}).get("slug") if isinstance(item.get("toolkit"), dict) else None
    if not isinstance(identifier, str) or not _ID.match(identifier) or not isinstance(toolkit, str):
        return None
    return Account(
        id=identifier,
        toolkit=toolkit[:64],
        alias=_text(item.get("alias"), 64),
        status=(_text(item.get("status"), 32) or "UNKNOWN").upper(),
        created_at=_text(item.get("created_at"), 64),
        updated_at=_text(item.get("updated_at"), 64),
    )


class ComposioClient:
    def __init__(self, api_key: str, *, transport: httpx.AsyncBaseTransport | None = None, base_url: str = BASE_URL) -> None:
        self._key = api_key
        self._transport = transport
        self._base = base_url

    async def _request(self, method: str, path: str, *, body: dict | None = None, params: dict | None = None,
                       timeout: float = TIMEOUT_SECONDS):
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=timeout, follow_redirects=False,
                headers={"x-api-key": self._key, "accept": "application/json"},
            ) as client:
                response = await client.request(method, self._base + path, json=body, params=params)
        except httpx.HTTPError:
            raise ComposioError("unavailable", "Could not reach Composio. Check your connection and try again.") from None
        if len(response.content) > MAX_RESPONSE_BYTES:
            raise ComposioError("bad_response", "Composio sent an unexpectedly large response.")
        if 300 <= response.status_code < 400:
            raise ComposioError("bad_response", "Composio answered with a redirect, which this app does not follow.")
        if response.status_code >= 400:
            raise self._failure(response)
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            raise ComposioError("bad_response", "Composio sent a response this app cannot read.") from None

    def _failure(self, response: httpx.Response) -> ComposioError:
        try:
            detail = _text(((response.json() or {}).get("error") or {}).get("message"))
        except (ValueError, AttributeError):
            detail = None
        if detail:
            # A message that repeats the key must not carry it to the browser or a log.
            detail = detail.replace(self._key, "[key]")
        status = response.status_code
        if status in (401, 403):
            return ComposioError("key_rejected", detail or "Composio did not accept this key.")
        if status == 404:
            return ComposioError("not_found", detail or "Composio could not find that.")
        if status == 429:
            return ComposioError("rate_limited", "Composio is rate limiting requests. Try again in a minute.")
        if status >= 500:
            return ComposioError("unavailable", "Composio had a problem. Try again shortly.")
        return ComposioError("rejected", detail or "Composio refused the request.")

    async def create_session(self, user_id: str) -> str:
        body = {
            "user_id": user_id,
            "manage_connections": {"enable": True, "enable_wait_for_connections": True, "enable_connection_removal": True},
            "multi_account": {"enable": True, "max_accounts_per_toolkit": 5, "require_explicit_selection": True},
        }
        result = await self._request("POST", "/tool_router/session", body=body)
        session_id = result.get("session_id") if isinstance(result, dict) else None
        if not isinstance(session_id, str) or not _ID.match(session_id):
            raise ComposioError("bad_response", "Composio did not return a session.")
        return session_id

    async def link(self, session_id: str, toolkit: str, alias: str) -> Link:
        result = await self._request(
            "POST", f"/tool_router/session/{session_id}/link", body={"toolkit": toolkit, "alias": alias}
        )
        result = result if isinstance(result, dict) else {}
        url = trusted_link(result.get("redirect_url"))
        account_id = result.get("connected_account_id")
        if url is None or not isinstance(account_id, str) or not _ID.match(account_id):
            raise ComposioError("bad_response", "Composio returned a connect link this app will not open.")
        return Link(redirect_url=url, account_id=account_id)

    async def accounts(self, user_id: str, toolkit: str | None = None) -> list[Account]:
        found: list[Account] = []
        cursor = None
        for _ in range(MAX_PAGES):
            params = {"user_ids": user_id, "limit": PAGE_LIMIT, "order_by": "updated_at"}
            if toolkit:
                params["toolkit_slugs"] = toolkit
            if cursor:
                params["cursor"] = cursor
            result = await self._request("GET", "/connected_accounts", params=params)
            result = result if isinstance(result, dict) else {}
            for item in result.get("items") or []:
                # The listing is already filtered by user; refuse a stray row anyway.
                if isinstance(item, dict) and item.get("user_id") not in (None, user_id):
                    continue
                account = _account(item)
                if account is not None:
                    found.append(account)
            cursor = result.get("next_cursor")
            if not isinstance(cursor, str) or not cursor:
                break
        return found

    async def execute(self, session_id: str, tool_slug: str, arguments: dict, account_id: str) -> "Execution":
        """Run one Composio tool as the account. `data` is Composio's raw answer: the
        caller trims it before anything is shown, and it is never logged."""
        if not _ID.match(session_id) or not _SLUG.match(tool_slug) or not _ID.match(account_id):
            raise ComposioError("rejected", "This call was not sent.")
        result = await self._request(
            "POST", f"/tool_router/session/{session_id}/execute", timeout=EXECUTE_TIMEOUT_SECONDS,
            body={"tool_slug": tool_slug, "arguments": arguments, "account": account_id},
        )
        result = result if isinstance(result, dict) else {}
        error = result.get("error")
        if isinstance(error, dict):
            error = error.get("message")
        return Execution(
            result_type=_text(result.get("result_type"), 32) or "unknown",
            data=result.get("data"),
            error=_text(error.replace(self._key, "[key]") if isinstance(error, str) else None),
        )

    async def delete_account(self, account_id: str) -> None:
        if not _ID.match(account_id):
            raise ComposioError("not_found", "Composio could not find that account.")
        await self._request("DELETE", f"/connected_accounts/{account_id}", params={"revoke_on_delete": "true"})
