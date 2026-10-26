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

from app import composio_tools
from app.core.logging import get_logger
from app.services import composio_service
from app.services.composio_client import ComposioClient

logger = get_logger(__name__)

SERVER = "composio"
PREFIX = f"mcp__{SERVER}__"
MAX_REQUEST_BYTES = 16_000


def apps_for(scopes: object) -> frozenset:
    """The apps a stored `connector_scopes` value lets an agent read (v1: "read")."""
    if not isinstance(scopes, dict):
        return frozenset()
    return frozenset(app for app, level in scopes.items() if level == "read" and app in composio_tools.apps())


def make_client(key: str) -> ComposioClient:
    return ComposioClient(key)


class ComposioBridge:
    def __init__(self, runtime, run, apps: frozenset, client_factory=None):
        # Looked up when used, so a test can replace make_client.
        self.runtime, self.run, self.apps = runtime, run, apps
        self.client_factory = client_factory or (lambda key: make_client(key))
        self.folder = Path(tempfile.mkdtemp(prefix=f"open-dots-composio-{run.turn_id}-"))
        self.task: asyncio.Task | None = None
        self.calls: set[asyncio.Task] = set()

    @property
    def launch(self):
        apps = ",".join(sorted(self.apps))
        if getattr(sys, "frozen", False):
            return SimpleNamespace(command=sys.executable, args=["--composio-mcp", "--mailbox", str(self.folder), "--apps", apps], env={})
        root = str(Path(__file__).resolve().parents[2])
        return SimpleNamespace(
            command=sys.executable, args=["-m", "app.composio_mcp_server", "--mailbox", str(self.folder), "--apps", apps],
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

    async def allowed_now(self) -> frozenset:
        """What the agent may read right now, from the database."""
        from app.db.models import Agent

        async with self.runtime.session() as db:
            agent = await db.get(Agent, self.run.agent_id)
        return apps_for(agent.connector_scopes) if agent is not None and agent.archived_at is None else frozenset()

    async def execute(self, name: str, args: dict) -> dict:
        from app.team.bridge import consume_allowed_approval

        run, rt = self.run, self.runtime
        if run.ctx.aborted:
            return {"error": "This turn was stopped.", "code": "stopped"}
        async with rt.session() as db:
            approved = await consume_allowed_approval(db, run.turn_id, run.owner_token, PREFIX + name, args)
        if not approved:
            return {"error": "This call has no matching, unused approval.", "code": "not_approved"}
        allowed = await self.allowed_now() & self.apps
        if name == composio_tools.LIST_ACCOUNTS:
            if not allowed:
                return {"error": "This agent is no longer allowed to use connected apps.", "code": "not_allowed"}
            async with rt.session() as db:
                return await composio_service.connected_names(db, rt.owner_id, self.client_factory, allowed)
        tool = composio_tools.BY_NAME.get(name)
        if tool is None or tool.app not in allowed:
            return {"error": "This agent is not allowed to use that app.", "code": "not_allowed"}
        try:
            sent, account = composio_tools.clean_arguments(tool, args)
        except composio_tools.BadArguments as exc:
            return {"error": str(exc), "code": "bad_arguments"}
        async with rt.session() as db:
            return await composio_service.run_tool(db, rt.owner_id, self.client_factory, tool, sent, account)
