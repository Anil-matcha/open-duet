"""Every automatic tool decision passes through the durable approval gate."""
from app.computers import policy as computers
from app import composio_generic
from app.services import composio_policy
from app.team import policy as teams


def automatic(tool, mode, run, arguments):
    if getattr(run.ctx, "media_review_only", False):
        return "denied", "media_review_only"
    if getattr(run.ctx, "draft_only", False) and not tool.startswith(composio_policy.PREFIX):
        return "denied", "draft_only_run"
    if tool.startswith('mcp__memory__'):
        # Read-only search of the agent's own history (memory_bridge.py).
        return ('allowed', 'memory_read') if tool in ('mcp__memory__session_search', 'mcp__memory__session_read') else ('denied', 'unknown_memory_tool')
    if tool.startswith('mcp__team__'):
        return teams.automatic(tool, mode, run.ctx.team, arguments)
    if tool.startswith(composio_policy.PREFIX):
        # Connected apps (composio_bridge.py): decided here, never by a saved command rule.
        grants = getattr(run, "routine_grants", None)
        if grants is not None:
            name = tool.removeprefix(composio_policy.PREFIX)
            from app import composio_tools
            found = composio_tools.BY_NAME.get(name)
            if name not in grants or found is None:
                return "denied", "routine_action_not_granted"
            if found.kind == "write":
                if name not in composio_tools.ROUTINE_WRITE_TOOLS or not composio_tools.allows((run.ctx.composio_apps or {}).get(found.app), "write"):
                    return "denied", "routine_write_not_granted"
                if mode == "plan":
                    return "denied", "plan_mode"
                return "allowed", "routine_write_grant"
        decision = composio_policy.automatic(tool, mode, run.ctx.composio_apps, arguments, getattr(run.ctx, "composio_first_use_hit", False))
        if tool == composio_policy.PREFIX + composio_generic.RUN:
            # A generic call decided without a card is remembered, so the bridge checks it again before it runs.
            key, calls = composio_generic.call_key(arguments), getattr(run.ctx, "composio_auto_calls", None)
            if calls is not None:
                if decision is not None and decision[0] == "allowed":
                    calls.add(key)
                else:
                    calls.discard(key)
        return decision
    # Screen grants are turn scoped and are never persisted as command rules.
    if tool in computers.SCREEN_INPUT or tool in computers.SCREEN_READ:
        return computers.automatic(tool, mode, screen_granted=getattr(run, "screen_granted", False))
    return computers.automatic(tool, mode)
