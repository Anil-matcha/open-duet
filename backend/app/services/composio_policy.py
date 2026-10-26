"""What a connected-app tool call is allowed to do without asking.

Every call to the `composio` MCP server reaches the approval gate with the name
`mcp__composio__<tool>` (thread_runtime.ThreadApprovalGate.open); this decides
it. Only the tools in app/composio_tools.py exist; there are no writes in v1, so
nothing here ever asks a person: a read of an app the agent was allowed is
recorded as allowed, everything else is denied. The decision is recorded like any
other, and the bridge claims the matching one-use approval before it runs the call.
"""
from app import composio_tools

PREFIX = "mcp__composio__"


def automatic(tool: str, mode: str | None, apps: frozenset | None):
    """('allowed' | 'denied', reason) for a composio tool, or None when `tool`
    is not one. `apps` is what this turn's agent may read."""
    if not tool.startswith(PREFIX):
        return None
    if not apps:
        return "denied", "no_connected_apps"
    name = tool.removeprefix(PREFIX)
    if name == composio_tools.LIST_ACCOUNTS:
        return "allowed", "composio_list"
    found = composio_tools.BY_NAME.get(name)
    if found is None:
        return "denied", "unknown_composio_tool"
    if found.app not in apps:
        return "denied", "app_not_allowed"
    if found.kind != "read":
        return "denied", "write_not_available"
    return "allowed", "composio_read"
