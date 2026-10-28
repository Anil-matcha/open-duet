"""What a connected-app tool call is allowed to do without asking.

Every call to the `composio` MCP server reaches the approval gate with the name
`mcp__composio__<tool>` (thread_runtime.ThreadApprovalGate.open); this decides
it. Only the tools in app/composio_tools.py exist.

- A generic action (composio_generic.py) is never trusted as a read: it needs the Read-and-change
  level and a card every time. Only a reviewed read may skip the card, after its first approved run.
- A read of an app the agent was allowed is recorded as allowed, with no card.
- A write needs the agent's "write" level, is never decided here (a person
  decides on a card; no saved rule applies), and is denied in plan mode.
- Anything else is denied.

The decision is recorded like any other, and the bridge claims the matching
one-use approval before it runs the call.
"""
from app import composio_generic, composio_tools

PREFIX = "mcp__composio__"


def _generic(name: str, mode: str | None, levels: dict, arguments: object, first_use_hit: bool):
    """The decision for the two generic tools (composio_generic.py). Nothing here trusts what the agent says about an
    action: an action is unknown unless the backend lists it as a reviewed read, and an unknown one needs the
    agent's Read-and-change level, is denied in plan mode, and asks a person on a card every time."""
    args = arguments if isinstance(arguments, dict) else {}
    app = args.get("app")
    if not isinstance(app, str) or levels.get(app) not in composio_tools.LEVELS:
        return "denied", "app_not_allowed"
    if composio_generic.refusal_for(app, args.get("action") if name == composio_generic.RUN else None):
        return "denied", "generic_not_available"
    if name == composio_generic.SEARCH:
        return "allowed", "composio_search"
    action = args.get("action")
    reviewed = isinstance(action, str) and action in composio_generic.REVIEWED_READS
    if levels[app] != "write" and not reviewed:
        return "denied", "write_not_allowed"
    if mode == "plan" and not reviewed:
        return "denied", "plan_mode"
    if reviewed and first_use_hit:
        return "allowed", "composio_reviewed_read"
    return None  # a person decides: the first use of a reviewed read, and every call of anything else


def automatic(tool: str, mode: str | None, levels: dict | None, arguments: object = None, first_use_hit: bool = False):
    """('allowed' | 'denied', reason) for a composio tool, None when a person must
    decide, or None for a tool that is not a composio tool. `levels` is what this
    turn's agent may do, {app: "read" | "write"}."""
    if not tool.startswith(PREFIX):
        return None
    if not levels:
        return "denied", "no_connected_apps"
    name = tool.removeprefix(PREFIX)
    if name in composio_generic.GENERIC_TOOLS:
        return _generic(name, mode, levels, arguments, first_use_hit)
    if name == composio_tools.LIST_ACCOUNTS:
        return "allowed", "composio_list"
    found = composio_tools.BY_NAME.get(name)
    if found is None:
        return "denied", "unknown_composio_tool"
    level = levels.get(found.app)
    if level is None:
        return "denied", "app_not_allowed"
    if not composio_tools.allows(level, found.kind):
        return "denied", "write_not_allowed"
    if found.kind == "read":
        return "allowed", "composio_read"
    if mode == "plan":
        return "denied", "plan_mode"
    return None  # a change: the person decides on a card
