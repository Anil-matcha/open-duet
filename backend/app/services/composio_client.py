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

import hashlib
import json
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
TOOLKIT_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
CATALOG_PAGE_LIMIT = 500
MAX_SCHEMA_BYTES = 60_000


class ComposioError(Exception):
    """`kind` says what the app should do about it:
    key_rejected (the key is wrong), permission_denied (the key is valid but
    lacks a required permission), not_found,
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
class Toolkit:
    """One app of Composio's catalog, reduced to display fields."""
    slug: str
    name: str
    description: str
    logo: str | None
    categories: tuple
    no_auth: bool
    managed_auth: bool        # Composio supplies the sign-in (no auth config of your own is needed)
    tools_count: int | None


@dataclass(frozen=True)
class ToolkitPage:
    items: list
    next_cursor: str | None
    total_items: int | None
    current_page: int | None
    total_pages: int | None


@dataclass(frozen=True)
class ToolInfo:
    """One Composio tool as the catalog describes it. `schema` is the JSON Schema of its
    input; None when it was missing or too large to trust."""
    slug: str
    name: str
    description: str
    toolkit: str
    version: str | None
    schema: dict | None
    tags: tuple
    deprecated: bool


@dataclass(frozen=True)
class ToolPage:
    items: list
    next_cursor: str | None


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


def _logo(raw: object) -> str | None:
    """An image address is passed on only when it is https on a Composio host: the page
    loads it in the owner's browser, so any other host would learn that they are here."""
    if not isinstance(raw, str) or len(raw) > 500:
        return None
    try:
        parts = urlsplit(raw)
        host = parts.hostname or ""
        port = parts.port
    except ValueError:
        return None
    if parts.scheme != "https" or parts.username or parts.password or port not in (None, 443):
        return None
    return raw if host == "composio.dev" or host.endswith(".composio.dev") else None


def _count(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 10_000_000 else None


def _toolkit(item: object) -> Toolkit | None:
    if not isinstance(item, dict):
        return None
    slug = item.get("slug")
    if not isinstance(slug, str) or not TOOLKIT_SLUG.match(slug.lower()):
        return None
    meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
    names = []
    for entry in meta.get("categories") or []:
        name = entry.get("name") if isinstance(entry, dict) else entry
        if isinstance(name, str) and name.strip():
            names.append(name.strip()[:40])
    managed = item.get("composio_managed_auth_schemes")
    return Toolkit(
        slug=slug.lower(),
        name=_text(item.get("name"), 80) or slug,
        description=_text(meta.get("description"), 300) or "",
        logo=_logo(meta.get("logo")),
        categories=tuple(dict.fromkeys(names))[:4],
        no_auth=item.get("no_auth") is True,
        managed_auth=isinstance(managed, list) and any(isinstance(x, str) for x in managed),
        tools_count=_count(meta.get("tools_count")),
    )


def _tool(item: object) -> ToolInfo | None:
    if not isinstance(item, dict):
        return None
    slug = item.get("slug")
    toolkit = (item.get("toolkit") or {}).get("slug") if isinstance(item.get("toolkit"), dict) else None
    if not isinstance(slug, str) or not _SLUG.match(slug) or not isinstance(toolkit, str) or not TOOLKIT_SLUG.match(toolkit.lower()):
        return None
    schema = item.get("input_parameters")
    if not isinstance(schema, dict) or len(json.dumps(schema, default=str)) > MAX_SCHEMA_BYTES:
        schema = None
    tags = item.get("tags")
    return ToolInfo(
        slug=slug,
        name=_text(item.get("name"), 120) or slug,
        description=_text(item.get("description"), 600) or "",
        toolkit=toolkit.lower(),
        version=_text(item.get("version"), 40),
        schema=schema,
        tags=tuple(t[:40] for t in tags if isinstance(t, str))[:12] if isinstance(tags, list) else (),
        deprecated=item.get("is_deprecated") is True,
    )


class ComposioClient:
    def __init__(self, api_key: str, *, transport: httpx.AsyncBaseTransport | None = None, base_url: str = BASE_URL) -> None:
        self._key = api_key
        self._transport = transport
        self._base = base_url

    def identity(self) -> str:
        """A short fingerprint of this client's project (key and address), for keeping one project's cached data apart from
        another's. It cannot be turned back into the key."""
        return hashlib.sha256(f"{self._base}|{self._key}".encode("utf-8")).hexdigest()[:24]

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
        if status == 401:
            # Composio can report a scoped permission denial as a generic 401,
            # so the settings layer must not imply that the key itself is bad.
            return ComposioError("key_rejected", detail or "Composio did not accept this key.")
        if status == 403:
            return ComposioError("permission_denied", detail or "Composio denied this key's permissions.")
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

    async def toolkits(self, cursor: str | None = None, limit: int = CATALOG_PAGE_LIMIT) -> ToolkitPage:
        """One page of Composio's app catalog, most used first (GET /toolkits)."""
        params: dict = {"limit": limit, "sort_by": "usage"}
        if cursor:
            params["cursor"] = cursor
        result = await self._request("GET", "/toolkits", params=params)
        result = result if isinstance(result, dict) else {}
        items = [found for found in (_toolkit(item) for item in result.get("items") or []) if found is not None]
        cursor_next = result.get("next_cursor")
        return ToolkitPage(
            items=items,
            next_cursor=cursor_next if isinstance(cursor_next, str) and cursor_next else None,
            total_items=_count(result.get("total_items")),
            current_page=_count(result.get("current_page")),
            total_pages=_count(result.get("total_pages")),
        )

    async def toolkit(self, slug: str) -> Toolkit:
        """One app of the catalog (GET /toolkits/{slug}); not_found when Composio has no such app."""
        if not TOOLKIT_SLUG.match(slug):
            raise ComposioError("not_found", "Composio could not find that app.")
        found = _toolkit(await self._request("GET", f"/toolkits/{slug}"))
        if found is None or found.slug != slug:
            raise ComposioError("not_found", "Composio could not find that app.")
        return found

    async def tools(self, toolkit: str, query: str | None = None, cursor: str | None = None, limit: int = 10) -> ToolPage:
        """Tools of one app, optionally matching words (GET /tools). Only tools that belong to that app are kept."""
        if not TOOLKIT_SLUG.match(toolkit):
            raise ComposioError("not_found", "Composio could not find that app.")
        params: dict = {"toolkit_slug": toolkit, "limit": limit}
        if query:
            params["query"] = query
        if cursor:
            params["cursor"] = cursor
        result = await self._request("GET", "/tools", params=params)
        result = result if isinstance(result, dict) else {}
        items = [found for found in (_tool(item) for item in result.get("items") or []) if found is not None and found.toolkit == toolkit]
        cursor_next = result.get("next_cursor")
        return ToolPage(items=items, next_cursor=cursor_next if isinstance(cursor_next, str) and cursor_next else None)

    async def tool(self, slug: str) -> ToolInfo:
        """One tool with its input schema (GET /tools/{slug}), as Composio now describes it."""
        if not _SLUG.match(slug):
            raise ComposioError("not_found", "Composio could not find that action.")
        found = _tool(await self._request("GET", f"/tools/{slug}"))
        if found is None or found.slug != slug:
            raise ComposioError("not_found", "Composio could not find that action.")
        return found

    async def delete_account(self, account_id: str) -> None:
        if not _ID.match(account_id):
            raise ComposioError("not_found", "Composio could not find that account.")
        await self._request("DELETE", f"/connected_accounts/{account_id}", params={"revoke_on_delete": "true"})
