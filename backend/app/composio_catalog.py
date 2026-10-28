"""The apps Open Duet agents can use through Composio, for the Apps page.

Membership, tool names and read/write kinds come from app/composio_tools.py, the
one allowlist; only the display text lives here. An app with no validated tool is
not listed, and an app listed here without display text fails a test, so the
two cannot drift. Nothing here talks to Composio or needs a saved key.
"""
from app import composio_tools

# Display text only: it never decides what an agent may do.
APP_INFO: dict[str, dict[str, str]] = {
    "github": {"name": "GitHub", "category": "Developer tools",
               "description": "Issues, pull requests, commits and files in your repositories."},
    "gmail": {"name": "Gmail", "category": "Communication",
              "description": "Search and read mail, and draft replies in your threads."},
    "googlecalendar": {"name": "Google Calendar", "category": "Productivity",
                       "description": "See your calendars and upcoming events."},
}


def supported_apps() -> tuple[tuple[str, str], ...]:
    """(slug, name) of every app that has at least one validated tool."""
    return tuple((slug, APP_INFO[slug]["name"]) for slug in composio_tools.apps())


def catalog() -> list[dict]:
    """Each supported app with its display text and the tools an agent can be given."""
    found = []
    for slug, name in supported_apps():
        info = APP_INFO[slug]
        found.append({
            "app": slug,
            "name": name,
            "description": info["description"],
            "category": info["category"],
            "tools": [{"name": tool.name, "kind": tool.kind, "description": tool.description}
                      for tool in composio_tools.TOOLS if tool.app == slug],
        })
    return found
