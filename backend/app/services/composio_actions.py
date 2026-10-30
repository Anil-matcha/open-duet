"""Generic connected-app actions, run by the backend (composio_generic.py has the rules).

`search` lists actions of one connected app. `run` runs one named action as one connected account, only
after these checks, all made here by the backend and none by anything the agent said:

  1. the action belongs to the named app, is not a proxy, code or shell tool, and the app has no curated
     tools (those are the only tools such an app has);
  2. its schema is fetched from Composio now, is one this backend can check, and has the `revision` the
     agent was given by the search (a schema that changed while a card waited is refused);
  3. the arguments fit the schema, are small enough to show in full, and carry no credential;
  4. exactly one connected account of the app matches;
  5. a call decided without a card (a reviewed read after its first use) still has that first use on record
     for this agent, this account, this action and this revision.

The call is sent once, never retried, and an answer that did not arrive is reported as unknown: every
generic action is treated as a change. First uses are kept in the encrypted Composio record (no table),
so replacing or removing the key drops them; disconnecting an account and changing an agent's apps drop
the ones they cover.
"""
from sqlalchemy.ext.asyncio import AsyncSession

from app import composio_generic as generic
from app.services import composio_service as service
from app.services.composio_client import ComposioError

MAX_FIRST_USES = 500


def _entry_key(agent_id: int, account_id: str, slug: str) -> str:
    return f"{agent_id}|{account_id}|{slug}"


async def first_use_hit(db: AsyncSession, owner_id: str, agent_id: int | None, arguments: object) -> bool:
    """For the approval policy, before it decides a run request: is this a reviewed read that this agent has already
    run successfully? Cheap: anything that is not a reviewed read answers False without touching the database."""
    action = arguments.get("action") if isinstance(arguments, dict) else None
    if agent_id is None or not isinstance(action, str) or action not in generic.REVIEWED_READS:
        return False
    record = await service.load(db, owner_id)
    uses = (record or {}).get("first_use") or {}
    return any(key.startswith(f"{agent_id}|") and key.endswith(f"|{action}") for key in uses)


async def record_first_use(db: AsyncSession, owner_id: str, agent_id: int, account_id: str, app: str, slug: str, revision: str) -> None:
    async with service.lock:
        record = await service.load(db, owner_id)
        if record is None:
            return
        uses = dict(record.get("first_use") or {})
        uses[_entry_key(agent_id, account_id, slug)] = {"revision": revision, "app": app}
        for old in list(uses)[:-MAX_FIRST_USES]:
            del uses[old]
        await service._save(db, owner_id, {**record, "first_use": uses})


async def forget(db: AsyncSession, owner_id: str, *, agent_id: int | None = None, account_id: str | None = None, app: str | None = None) -> None:
    """Drop first uses that an agent, an account or an app covers (any one of them given); no filter drops none."""
    if agent_id is None and account_id is None and app is None:
        return
    async with service.lock:
        record = await service.load(db, owner_id)
        uses = (record or {}).get("first_use") or {}
        keep = {}
        for key, entry in uses.items():
            agent, account, _ = key.split("|", 2)
            dropped = (agent_id is not None and agent == str(agent_id)) or (account_id is not None and account == account_id) \
                or (app is not None and isinstance(entry, dict) and entry.get("app") == app)
            if not dropped:
                keep[key] = entry
        if record is not None and keep != uses:
            await service._save(db, owner_id, {**record, "first_use": keep})


async def search(db: AsyncSession, owner_id: str, make_client, *, app: str, query: str | None, cursor: str | None,
                 allowed_account_ids: list[str] | None = None) -> dict:
    """A page of actions of one connected app, with each one's revision and parameters."""
    refused = generic.refusal_for(app)
    if refused:
        return {"error": refused[1], "code": refused[0]}
    record = await service.load(db, owner_id)
    if record is None:
        return {"error": "Connected apps are not set up. The person can add their Composio key on the Apps page.", "code": "not_configured"}
    client = make_client(record["api_key"])
    try:
        if not any(a.status == "ACTIVE" and (allowed_account_ids is None or a.id in allowed_account_ids)
                   for a in await client.accounts(record["user_id"], app)):
            return {"error": f"No {app} account is connected. The person can connect one on the Apps page.", "code": "not_connected"}
        page = await client.tools(app, query, cursor, limit=generic.MAX_SEARCH_RESULTS + 4)
    except ComposioError as exc:
        return service._agent_error(exc)
    return generic.search_result(app, page.items, page.next_cursor)


async def run(db: AsyncSession, owner_id: str, make_client, *, agent_id: int, auto_called: bool, request: dict,
              allowed_account_ids: list[str] | None = None) -> dict:
    """Run one generic action. `request` is generic.parse_run's result. `auto_called` is True when no card was shown
    for this call (a reviewed read), which then needs its first use on record."""
    app, action, alias = request["app"], request["action"], request["account"]
    refused = generic.refusal_for(app, action)
    if refused:
        return {"error": refused[1], "code": refused[0]}
    record = await service.load(db, owner_id)
    if record is None:
        return {"error": "Connected apps are not set up. The person can add their Composio key on the Apps page.", "code": "not_configured"}
    client = make_client(record["api_key"])
    try:
        info = await client.tool(action)
    except ComposioError as exc:
        return service._agent_error(exc)
    if info.toolkit != app:
        return {"error": f"That action does not belong to {app}.", "code": "wrong_app"}
    if info.deprecated:
        return {"error": "That action is deprecated and cannot be run.", "code": "deprecated_action"}
    problem = generic.check_schema(info.schema)
    if problem:
        return {"error": f"This action cannot be run here: {problem}.", "code": "unsupported_schema"}
    revision = generic.revision_of(info.slug, info.version, info.schema)
    if revision != request["revision"]:
        return {"error": "This action changed since it was searched. Search again and ask the person again.", "code": "schema_changed"}
    try:
        generic.validate_arguments(info.schema, request["arguments"])
    except generic.GenericError as exc:
        return {"error": str(exc), "code": "bad_arguments"}
    try:
        active = [a for a in await client.accounts(record["user_id"], app)
                  if a.status == "ACTIVE" and (allowed_account_ids is None or a.id in allowed_account_ids)]
        account, problem_reply = service._choose(active, alias, app)
        if problem_reply:
            return problem_reply
        reviewed = generic.is_reviewed_read(info.slug, info.version, info.schema)
        if auto_called:
            stored = ((await service.load(db, owner_id)) or {}).get("first_use") or {}
            entry = stored.get(_entry_key(agent_id, account.id, info.slug))
            if not (reviewed and isinstance(entry, dict) and entry.get("revision") == revision):
                await forget(db, owner_id, agent_id=agent_id, app=app)
                return {"error": "This action needs the person's approval first. Ask again.", "code": "first_use_required"}
        session_id, record = await service._session(db, owner_id, client, record)
    except ComposioError as exc:  # nothing was sent for the action yet
        return service._agent_error(exc)
    try:
        done = await client.execute(session_id, info.slug, request["arguments"], account.id)
    except ComposioError as exc:
        if exc.kind in ("unavailable", "bad_response"):
            return dict(service.OUTCOME_UNKNOWN)
        if exc.kind == "not_found":
            try:  # Composio forgot the session; it is replaced, and the call is not repeated
                await service._session(db, owner_id, client, record, replace=session_id)
            except ComposioError as again:
                return service._agent_error(again)
            return dict(service.SESSION_EXPIRED)
        return service._agent_error(exc)
    if done.result_type == "completed":
        if reviewed:
            await record_first_use(db, owner_id, agent_id, account.id, app, info.slug, revision)
        return generic.bounded_result(app, info.slug, done.data)
    if done.result_type == "failed":
        return {"error": "The app refused or could not do that" + (f": {done.error}" if done.error else "."), "code": "app_error"}
    return {"error": "Composio did not run this call.", "code": "not_run"}
