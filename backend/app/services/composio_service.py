"""Composio connected apps: the saved key and what Settings does with it.

One encrypted row in the credential table (`user_credential`, provider
`integration:composio`, like `engine:<id>`; no migration):

    {"api_key": "ak_...", "user_id": "opendots_<hex>", "session_id": "..." | null}

`user_id` is this installation's one Composio user. Connections belong to that
user, not to a session, so a lost session is replaced without losing them.
The key is never returned, logged or audited; `status()` says only whether
one is saved.
"""

import asyncio
import json
import re
import uuid

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.user_credential import UserCredential
from app.db.transactions import begin_write
from app.services import user_credential_service
from app.services.composio_client import Account, ComposioClient, ComposioError, Link

PROVIDER = "integration:composio"
_NOT_A_FILE = "-"

# The apps Settings offers in this version. Agents cannot use them yet, so the
# list stays short; a slug outside it is refused even if Composio knows it.
SUPPORTED_APPS: tuple[tuple[str, str], ...] = (
    ("github", "GitHub"),
    ("gmail", "Gmail"),
    ("googlecalendar", "Google Calendar"),
)
MAX_ACCOUNTS_PER_APP = 5

_KEY = re.compile(r"^ak_[A-Za-z0-9_-]{8,200}$")
_ALIAS = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$")

# One key change or session creation at a time.
lock = asyncio.Lock()


class UserError(Exception):
    """A request the owner can fix. `code` is the machine-readable cause."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def valid_key(key: object) -> bool:
    return isinstance(key, str) and _KEY.match(key) is not None


def valid_alias(alias: object) -> bool:
    return isinstance(alias, str) and _ALIAS.match(alias) is not None


async def load(db: AsyncSession, owner_id: str) -> dict | None:
    """The saved record, or None when there is none or it cannot be read."""
    try:
        found = await user_credential_service.get_decrypted(db, owner_id, PROVIDER)
        record = json.loads(found[0]) if found else None
    except Exception:  # noqa: BLE001  (a row that no longer decrypts reads as no key)
        return None
    if not isinstance(record, dict) or not valid_key(record.get("api_key")) or not isinstance(record.get("user_id"), str):
        return None
    return record


async def _save(db: AsyncSession, owner_id: str, record: dict) -> None:
    await user_credential_service.save_token(
        db, user_id=owner_id, provider=PROVIDER, file_path=_NOT_A_FILE,
        plaintext=json.dumps(record, ensure_ascii=False),
    )


async def configured(db: AsyncSession, owner_id: str) -> bool:
    return await load(db, owner_id) is not None


async def set_key(db: AsyncSession, owner_id: str, key: str, make_client) -> None:
    """Check the key with Composio, then save it. A different key means a
    different project, so the saved session is dropped; the user id stays."""
    if not valid_key(key):
        raise UserError(422, "invalid_composio_key", "A Composio project key starts with ak_ and has no spaces.")
    async with lock:
        previous = await load(db, owner_id)
        user_id = previous["user_id"] if previous else "opendots_" + uuid.uuid4().hex
        try:
            await make_client(key).accounts(user_id)
        except ComposioError as exc:
            raise _user_error(exc, saving=True) from None
        await _save(db, owner_id, {"api_key": key, "user_id": user_id, "session_id": None})


async def remove_key(db: AsyncSession, owner_id: str) -> None:
    """Forget the key and the session. Connected accounts stay at Composio:
    this does not revoke them."""
    async with lock:
        await begin_write(db)
        await db.execute(
            delete(UserCredential).where(UserCredential.user_id == owner_id, UserCredential.provider == PROVIDER)
        )
        await db.commit()


async def _needed(db: AsyncSession, owner_id: str) -> dict:
    record = await load(db, owner_id)
    if record is None:
        raise UserError(409, "composio_not_configured", "Add your Composio key in Settings first.")
    return record


def _user_error(exc: ComposioError, *, saving: bool = False) -> UserError:
    if exc.kind == "key_rejected":
        message = "Composio did not accept this key. Check that it is a project key." if saving else \
            "Composio no longer accepts the saved key. Replace it in Settings."
        return UserError(422 if saving else 409, "composio_key_rejected", message)
    if exc.kind == "rate_limited":
        return UserError(429, "composio_rate_limited", exc.message)
    if exc.kind == "unavailable":
        return UserError(502, "composio_unavailable", exc.message)
    if exc.kind == "not_found":
        return UserError(404, "composio_not_found", exc.message)
    if exc.kind == "bad_response":
        return UserError(502, "composio_bad_response", exc.message)
    return UserError(422, "composio_rejected", exc.message)


async def accounts(db: AsyncSession, owner_id: str, make_client) -> list[Account]:
    record = await _needed(db, owner_id)
    try:
        return await make_client(record["api_key"]).accounts(record["user_id"])
    except ComposioError as exc:
        raise _user_error(exc) from None


async def connect(db: AsyncSession, owner_id: str, make_client, toolkit: str, alias: str | None) -> Link:
    if toolkit not in dict(SUPPORTED_APPS):
        raise UserError(422, "unsupported_app", "That app is not available yet.")
    if alias is not None and not valid_alias(alias):
        raise UserError(422, "invalid_alias", "Use up to 40 letters, numbers, spaces, dots, dashes or underscores.")
    async with lock:
        record = await _needed(db, owner_id)
        client = make_client(record["api_key"])
        try:
            existing = [a for a in await client.accounts(record["user_id"], toolkit) if a.status != "FAILED"]
            if len(existing) >= MAX_ACCOUNTS_PER_APP:
                raise UserError(409, "too_many_accounts", f"Disconnect an account first; {MAX_ACCOUNTS_PER_APP} is the most per app.")
            alias = alias or "od-" + uuid.uuid4().hex[:6]
            if any((a.alias or "").lower() == alias.lower() for a in existing):
                raise UserError(409, "alias_in_use", "You already have an account with that name for this app.")
            for attempt in range(2):
                session_id = record.get("session_id")
                if not session_id:
                    session_id = await client.create_session(record["user_id"])
                    record = {**record, "session_id": session_id}
                    await _save(db, owner_id, record)
                try:
                    return await client.link(session_id, toolkit, alias)
                except ComposioError as exc:
                    # A session Composio no longer knows is replaced once; the user keeps their accounts.
                    if exc.kind != "not_found" or attempt:
                        raise
                    record = {**record, "session_id": None}
            raise ComposioError("bad_response", "Composio did not give a connect link.")
        except ComposioError as exc:
            raise _user_error(exc) from None


def _agent_error(exc: ComposioError) -> dict:
    """What an agent is told when Composio could not be used. No detail from the
    response is passed on."""
    said = {
        "key_rejected": "The person's Composio key is no longer accepted. They need to replace it in Settings.",
        "rate_limited": "Composio is rate limiting requests. Try again later.",
        "unavailable": "Composio did not answer. Nothing was changed; the read may not have happened.",
        "not_found": "That app, account or tool was not found at Composio.",
    }
    return {"error": said.get(exc.kind, "Composio could not run this."), "code": "composio_" + exc.kind}


def _choose(active: list[Account], alias: str | None, app: str) -> tuple[Account | None, dict | None]:
    if not active:
        return None, {"error": f"No {app} account is connected. The person can connect one in Settings.", "code": "not_connected"}
    names = sorted(a.alias or a.id for a in active)
    if alias is not None:
        match = [a for a in active if (a.alias or "").lower() == alias.lower()]
        if len(match) != 1:
            return None, {"error": "No connected account has that name. Connected: " + ", ".join(names), "code": "unknown_account"}
        return match[0], None
    if len(active) > 1:
        return None, {"error": "More than one account is connected; say which with the account argument: " + ", ".join(names),
                      "code": "account_required"}
    return active[0], None


async def connected_names(db: AsyncSession, owner_id: str, make_client, allowed_apps) -> dict:
    """The names of the active accounts per allowed app, for the agent."""
    record = await load(db, owner_id)
    if record is None:
        return {"error": "Connected apps are not set up. The person can add their Composio key in Settings.", "code": "not_configured"}
    try:
        found = await make_client(record["api_key"]).accounts(record["user_id"])
    except ComposioError as exc:
        return _agent_error(exc)
    return {"apps": {app: sorted(a.alias or a.id for a in found if a.toolkit == app and a.status == "ACTIVE")
                     for app in sorted(allowed_apps)}}


async def _session(db: AsyncSession, owner_id: str, client: ComposioClient, record: dict, *, replace: str | None = None) -> tuple[str, dict]:
    """The saved session, or a new one. `replace` names a session that just failed:
    it is replaced only if nobody else already did."""
    async with lock:
        latest = await load(db, owner_id) or record
        session_id = latest.get("session_id")
        if session_id and session_id != replace:
            return session_id, latest
        session_id = await client.create_session(latest["user_id"])
        latest = {**latest, "session_id": session_id}
        await _save(db, owner_id, latest)
        return session_id, latest


OUTCOME_UNKNOWN = {
    "error": "The request was sent but no answer came back, so the change may or may not have been made. "
             "Do not repeat it; ask the person to check.",
    "code": "outcome_unknown",
}
SESSION_EXPIRED = {
    "error": "Composio's session had expired and nothing was changed. Ask the person before trying again.",
    "code": "session_expired",
}
DONE_UNREADABLE = {
    "result": "done", "code": "done_unreadable",
    "note": "The change was made, but GitHub's answer could not be read. Do not repeat it; ask the person to check.",
}


async def run_tool(db: AsyncSession, owner_id: str, make_client, tool, arguments: dict, alias: str | None) -> dict:
    """Run one allowed tool as one connected account and return what the agent may see.
    Never raises for a Composio problem: the agent gets a short error instead.

    A read may be retried once on a forgotten session. A change never is: it is sent
    once, and a failure that leaves it unknown is reported as unknown, so the agent is
    told not to repeat it. A change that went through is never reported as a failure."""
    from app import composio_tools

    write = tool.kind == "write"
    record = await load(db, owner_id)
    if record is None:
        return {"error": "Connected apps are not set up. The person can add their Composio key in Settings.", "code": "not_configured"}
    client = make_client(record["api_key"])
    try:
        active = [a for a in await client.accounts(record["user_id"], tool.app) if a.status == "ACTIVE"]
        account, problem = _choose(active, alias, tool.app)
        if problem:
            return problem
        session_id, record = await _session(db, owner_id, client, record)
    except ComposioError as exc:  # nothing was sent for the tool yet
        return _agent_error(exc)
    try:
        done = await client.execute(session_id, tool.slug, arguments, account.id)
    except ComposioError as exc:
        if write and exc.kind in ("unavailable", "bad_response"):
            return dict(OUTCOME_UNKNOWN)
        if exc.kind != "not_found":
            return _agent_error(exc)
        # Composio forgot the session (the connection belongs to the user, so it is replaced).
        try:
            session_id, record = await _session(db, owner_id, client, record, replace=session_id)
            if write:
                return dict(SESSION_EXPIRED)
            done = await client.execute(session_id, tool.slug, arguments, account.id)
        except ComposioError as again:
            return _agent_error(again)
    if done.result_type == "completed":
        try:
            return composio_tools.project(tool, done.data)
        except composio_tools.BadArguments as exc:
            return dict(DONE_UNREADABLE) if write else {"error": str(exc), "code": "unreadable_answer"}
    if done.result_type == "failed":
        return {"error": "The app refused or could not do that" + (f": {done.error}" if done.error else "."), "code": "app_error"}
    return {"error": "Composio did not run this call.", "code": "not_run"}


async def disconnect(db: AsyncSession, owner_id: str, make_client, account_id: str) -> None:
    record = await _needed(db, owner_id)
    client = make_client(record["api_key"])
    try:
        mine = {a.id for a in await client.accounts(record["user_id"])}
        if account_id not in mine:
            raise UserError(404, "account_not_found", "That account is not connected here.")
        await client.delete_account(account_id)
    except ComposioError as exc:
        error = _user_error(exc)
        if error.code in {"composio_unavailable", "composio_rate_limited"}:
            error.message = "The account was not removed from Composio. Try again; it may still be connected there."
        raise error from None
