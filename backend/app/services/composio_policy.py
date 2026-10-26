"""What a connected-app tool call is allowed to do without asking.

Every call to the `composio` MCP server reaches the approval gate with the name
`mcp__composio__<tool>` (thread_runtime.ThreadApprovalGate.open); this decides
it. Only the tools in app/composio_tools.py exist.

- A read of an app the agent was allowed is recorded as allowed, with no card.
- A write needs the agent's "write" level, is never decided here (a person
  decides on a card; no saved rule applies), and is denied in plan mode.
- Anything else is denied.

The decision is recorded like any other, and the bridge claims the matching
one-use approval before it runs the call.
"""
from app import composio_tools

PREFIX = "mcp__composio__"


def automatic(tool: str, mode: str | None, levels: dict | None):
    """('allowed' | 'denied', reason) for a composio tool, None when a person must
    decide, or None for a tool that is not a composio tool. `levels` is what this
    turn's agent may do, {app: "read" | "write"}."""
    if not tool.startswith(PREFIX):
        return None
    if not levels:
        return "denied", "no_connected_apps"
    name = tool.removeprefix(PREFIX)
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
