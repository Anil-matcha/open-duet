"""One turn's mailbox for the connected-app tools (composio_mcp_server.py).

The engine's MCP shim drops request files in a private folder; this polls them
and runs each as the person's Composio account. The shim has no key and no
network. A call runs only when, at this moment:

  1. the turn is still running and was not aborted,
  2. an unused, allowed approval matches the exact tool and arguments (the gate
     recorded it; it is claimed once, so a call cannot run twice), and
  3. the agent is still allowed to read the call's app (read again from the
     database, so removing an app mid-turn stops later calls).

Then the arguments are checked and rebuilt (composio_tools.clean_arguments) and
the answer is cut down to a whitelist before it goes back. A Composio failure
becomes a short error; no response text, key or URL is passed on.
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

from app import composio_generic, composio_tools
from app.core.logging import get_logger
from app.services import composio_actions, composio_service
from app.services.composio_client import ComposioClient

logger = get_logger(__name__)

SERVER = "composio"
PREFIX = f"mcp__{SERVER}__"
MAX_REQUEST_BYTES = 16_000


def apps_for(scopes: object) -> dict:
    """What a stored `connector_scopes` value lets an agent do: {app: "read" | "write"}, for the
    apps with curated tools and any other app name (which the generic tools reach only while it is
    still connected and not blocked; composio_actions checks that on every call). Anything else is ignored."""
    if not isinstance(scopes, dict):
        return {}
    return {app: level for app, level in scopes.items()
            if level in composio_tools.LEVELS and isinstance(app, str) and composio_generic.valid_app(app)
            and (app in composio_tools.apps() or not composio_generic.blocked_app(app))}


def make_client(key: str) -> ComposioClient:
    return ComposioClient(key)


class ComposioBridge:
    def __init__(self, runtime, run, apps: dict, client_factory=None):
        # Looked up when used, so a test can replace make_client.
        self.runtime, self.run, self.apps = runtime, run, apps
        self.client_factory = client_factory or (lambda key: make_client(key))
        self.folder = Path(tempfile.mkdtemp(prefix=f"open-dots-composio-{run.turn_id}-"))
        self.task: asyncio.Task | None = None
        self.calls: set[asyncio.Task] = set()

    @property
    def launch(self):
        apps = ",".join(f"{app}={level}" for app, level in sorted(self.apps.items()))
        grants = getattr(self.run, "routine_grants", None)
        exact = ["--exact-tools", ",".join(sorted(grants))] if grants is not None else []
        if getattr(sys, "frozen", False):
            return SimpleNamespace(command=sys.executable, args=["--composio-mcp", "--mailbox", str(self.folder), "--apps", apps] + exact, env={})
        root = str(Path(__file__).resolve().parents[2])
        return SimpleNamespace(
            command=sys.executable, args=["-m", "app.composio_mcp_server", "--mailbox", str(self.folder), "--apps", apps] + exact,
            env={"PYTHONPATH": root},
        )

    def start(self) -> None:
        self.task = asyncio.create_task(self.poll())

    async def close(self) -> None:
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        for task in self.calls:
            task.cancel()
        await asyncio.gather(*self.calls, return_exceptions=True)
        shutil.rmtree(self.folder, ignore_errors=True)

    async def poll(self) -> None:
        while not self.run.ctx.aborted:
            for path in self.folder.glob("req-*.json"):
                claimed = path.with_suffix(".working")
                try:
                    path.rename(claimed)
                except FileNotFoundError:
                    continue
                task = asyncio.create_task(self.handle(claimed))
                self.calls.add(task)
                task.add_done_callback(self.calls.discard)
            await asyncio.sleep(0.05)

    async def handle(self, path: Path) -> None:
        try:
            if path.stat().st_size > MAX_REQUEST_BYTES:
                result = {"error": "The request is too large.", "code": "too_large"}
            else:
                request = json.loads(path.read_text(encoding="utf-8"))
                name, args = request["name"], request["arguments"]
                if not isinstance(name, str) or not isinstance(args, dict):
                    raise ValueError("invalid")
                result = await self.execute(name, args)
        except Exception:  # noqa: BLE001
            logger.exception("a connected-app call failed", turn_id=self.run.turn_id)
            result = {"error": "The call could not be completed.", "code": "composio_error"}
        response = self.folder / path.name.replace("req-", "resp-").replace(".working", ".json")
        tmp = response.with_suffix(".tmp")
        tmp.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, response)
        path.unlink(missing_ok=True)

    async def allowed_now(self) -> dict:
        """What the agent may do right now, from the database: never more than the
        turn started with, so lowering a level mid-turn takes effect at once."""
        from app.db.models import Agent

        async with self.runtime.session() as db:
            agent = await db.get(Agent, self.run.agent_id)
        current = apps_for(agent.connector_scopes) if agent is not None and agent.archived_at is None and agent.owner_id == self.runtime.owner_id else {}
        return {app: ("write" if level == "write" and self.apps.get(app) == "write" else "read")
                for app, level in current.items() if app in self.apps}

    async def execute_generic(self, name: str, args: dict, allowed: dict) -> dict:
        """`app_search_actions` and `app_run_action` (composio_generic.py), after the approval above. What the agent may do is
        read again here: an app taken away, or a level lowered, while the card waited stops the call."""
        rt = self.runtime
        try:
            if name == composio_generic.SEARCH:
                app, query, cursor = composio_generic.parse_search(args)
                if app not in allowed:
                    return {"error": "This agent is not allowed to use that app.", "code": "not_allowed"}
                async with rt.session() as db:
                    return await composio_actions.search(db, rt.owner_id, self.client_factory, app=app, query=query, cursor=cursor)
            request = composio_generic.parse_run(args)
        except composio_generic.GenericError as exc:
            return {"error": str(exc), "code": "bad_arguments"}
        level = allowed.get(request["app"])
        reviewed = request["action"] in composio_generic.REVIEWED_READS
        if level is None or (level != "write" and not reviewed) or self.apps.get(request["app"]) is None:
            return {"error": "This agent is not allowed to do that with that app.", "code": "not_allowed"}
        auto = composio_generic.call_key(args) in self.run.ctx.composio_auto_calls
        async with rt.session() as db:
            return await composio_actions.run(db, rt.owner_id, self.client_factory, agent_id=self.run.agent_id, auto_called=auto, request=request)

    async def execute(self, name: str, args: dict) -> dict:
        result = await self._execute_checked(name, args)
        # Provider results already have reservation receipts. Keep pre-dispatch
        # refusals too, without retaining untrusted input arguments.
        if (getattr(self.run, "routine_grants", None) is not None
                and result.get("code") in {"not_allowed", "not_approved", "bad_arguments", "stopped", "already_attempted"}):
            from app.db.models.routine import RoutineAppAction, RoutineRun, Routine
            from app.db.transactions import begin_write
            async with self.runtime.session() as db:
                await begin_write(db)
                run_id = getattr(self.run, "routine_run_id", None)
                rr = await db.get(RoutineRun, run_id) if run_id else None
                routine = await db.get(Routine, rr.routine_id) if rr else None
                if routine is not None and routine.owner_id == self.runtime.owner_id:
                    db.add(RoutineAppAction(run_id=rr.id, tool=name[:200],
                           account_id=self.run.routine_grants.get(name, ""),
                           status="refused", code=result["code"]))
                    await db.commit()
        return result

    async def _execute_checked(self, name: str, args: dict) -> dict:
        from app.team.bridge import consume_allowed_approval

        run, rt = self.run, self.runtime
        if run.ctx.aborted:
            return {"error": "This turn was stopped.", "code": "stopped"}
        async with rt.session() as db:
            approved = await consume_allowed_approval(db, run.turn_id, run.owner_token, PREFIX + name, args)
        if not approved:
            return {"error": "This call has no matching, unused approval.", "code": "not_approved"}
        allowed = await self.allowed_now()
        if name == composio_tools.LIST_ACCOUNTS:
            if not allowed:
                return {"error": "This agent is no longer allowed to use connected apps.", "code": "not_allowed"}
            async with rt.session() as db:
                return await composio_service.connected_names(db, rt.owner_id, self.client_factory, set(allowed))
        if name in composio_generic.GENERIC_TOOLS:
            return await self.execute_generic(name, args, allowed)
        if name == "gmail_prepare_checked_reply" and not getattr(run.ctx, "draft_only", False):
            return {"error": "This tool requires a confined draft-only routine.", "code": "not_allowed"}
        tool = composio_tools.BY_NAME.get(name)
        if tool is None or not composio_tools.allows(allowed.get(tool.app), tool.kind):
            return {"error": "This agent is not allowed to do that with that app.", "code": "not_allowed"}
        try:
            sent, account = composio_tools.clean_arguments(tool, args)
        except composio_tools.BadArguments as exc:
            return {"error": str(exc), "code": "bad_arguments"}
        async with rt.session() as db:
            grants = getattr(run, "routine_grants", None)
            if grants is not None:
                return await self.execute_routine(db, name, tool, sent, account)
            return await composio_service.run_tool(db, rt.owner_id, self.client_factory, tool, sent, account)

    async def execute_routine(self, db, name, tool, sent, account):
        """A grant is checked again at dispatch; reserve writes before any I/O.

        A process exit or cancellation leaves a reserved receipt. It is deliberately
        never reclaimed: an external write may have completed without an answer.
        """
        import hashlib
        from sqlalchemy.exc import IntegrityError
        from app.core.config import settings
        from app.db.models.routine import Routine, RoutineRun, RoutineAppAction
        from app.db.transactions import begin_write

        run, rt = self.run, self.runtime
        grants = run.routine_grants
        bound = grants.get(name)
        routine = await db.get(Routine, run.routine_id)
        rr = await db.get(RoutineRun, getattr(run, "routine_run_id", None))
        current = {g["tool"]: g["account_id"] for g in routine.connected_app_grants} if routine else {}
        write = tool.kind == "write"
        permitted = (settings.ROUTINE_CONNECTED_APPS_ENABLED and bound
                     and current.get(name) == bound and routine.agent_id == run.agent_id
                     and routine.owner_id == rt.owner_id and run.ctx.computer is None
                     and rr is not None and rr.routine_id == routine.id
                     and rr.trigger in ("schedule", "manual") and rr.thread_id == run.thread_id
                     and rr.state in ("running", "needs_input")
                     and (not write or (name in composio_tools.ROUTINE_WRITE_TOOLS and run.ctx.approval_mode != "plan")))
        if not permitted or account is not None:
            return {"error": "Routine access was not granted, has been revoked, or the run is ineligible.", "code": "not_allowed"}
        from app.services import routine_drafts
        from dataclasses import replace
        draft_mode = routine_drafts.TOOL in grants
        if draft_mode and (not routine_drafts.valid_grants(grants)
                           or not getattr(run.ctx, "draft_only", False)):
            return {"error": "Draft-only confinement is unavailable.", "code": "not_allowed"}
        if name == routine_drafts.TOOL:
            checked = getattr(run, "checked_reply_sources", {}).get((bound, sent["message_id"]))
            if not checked or checked["thread_id"] != sent["thread_id"]:
                return {"error": "Read this exact message in this run before drafting.", "code": "not_allowed"}
            source_tool = replace(composio_tools.BY_NAME["gmail_fetch_message"], special="checked_message")
            fresh = await composio_service.run_tool(db, rt.owner_id, self.client_factory, source_tool,
                {"message_id": sent["message_id"], "user_id": "me", "format": "full"}, None, account_id=bound)
            if fresh.get("_checked_source") != checked:
                return {"error": "The source message changed or cannot be verified. No draft was created.", "code": "not_allowed"}
            profile = await composio_service.run_tool(db, rt.owner_id, self.client_factory,
                composio_tools.BY_NAME["gmail_get_profile"], {"user_id": "me"}, None, account_id=bound)
            own = profile.get("result", {}).get("emailAddress") if isinstance(profile.get("result"), dict) else None
            if not isinstance(own, str) or own.lower() == checked["sender"]:
                return {"error": "The sender is unavailable or is the connected account.", "code": "not_allowed"}
            # Refresh grants after network reads: revocation must block dispatch.
            await db.refresh(routine)
            await db.refresh(rr)
            current = {g["tool"]: g["account_id"] for g in routine.connected_app_grants}
            allowed = await self.allowed_now()
            if (current != grants or routine.owner_id != rt.owner_id or routine.agent_id != run.agent_id
                    or rr.state not in ("running", "needs_input") or rr.thread_id != run.thread_id
                    or rr.routine_id != routine.id or rr.trigger not in ("schedule", "manual")
                    or {g["tool"]: g["account_id"] for g in rr.connected_app_grants} != grants
                    or not composio_tools.allows(allowed.get("gmail"), "write")
                    or run.ctx.aborted or not settings.ROUTINE_CONNECTED_APPS_ENABLED):
                return {"error": "Draft access was revoked or stopped.", "code": "not_allowed"}
            sent = {key: value for key, value in sent.items() if key != "message_id"}
            sent["recipient_email"] = checked["sender"]
        request_key = hashlib.sha256(json.dumps({"tool": name, "arguments": sent}, sort_keys=True, separators=(",", ":")).encode()).hexdigest() if write else None
        if name == routine_drafts.TOOL:
            request_key = "checked-reply-draft-budget"
        receipt = RoutineAppAction(run_id=rr.id, tool=name, account_id=bound,
                                   request_key=request_key, status="reserved")
        await begin_write(db)
        db.add(receipt)
        try:
            await db.commit()
            await db.refresh(receipt)
        except IntegrityError:
            await db.rollback()
            return {"error": "This exact write was already attempted in this run. Check the external app and action history; do not repeat it.", "code": "already_attempted"}
        # Save the primary key before provider helpers commit or expire objects.
        receipt_id = receipt.id
        dispatch_tool = replace(tool, special="checked_message") if draft_mode and name == "gmail_fetch_message" else tool
        result = await composio_service.run_tool(db, rt.owner_id, self.client_factory, dispatch_tool, sent, None, account_id=bound)
        checked_source = result.pop("_checked_source", None)
        if checked_source and checked_source["message_id"] == sent.get("message_id"):
            if not hasattr(run, "checked_reply_sources"):
                run.checked_reply_sources = {}
            run.checked_reply_sources[(bound, checked_source["message_id"])] = checked_source
        code = result.get("code")
        if code == "outcome_unknown":
            status = "outcome_unknown"
        elif result.get("error"):
            status = "failed"
        else:
            status = "completed"
        await begin_write(db)
        receipt = await db.get(RoutineAppAction, receipt_id)
        receipt.status, receipt.code = status, code
        # Persist bounded projected write results (IDs/commit references), never
        # the input email body, file content or full read responses.
        receipt.result = (result if write else {"coverage_complete": not bool(result.get("truncated") or result.get("next_page_token"))}) if not result.get("error") else None
        await db.commit()
        return result
