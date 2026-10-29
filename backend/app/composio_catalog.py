"""The apps the Apps page lists.

Without a Composio key the page gets a bundled starter list, and says so. With one it gets Composio's own
catalog (GET /toolkits), read through the owner's key and cached for ten minutes. The cache belongs to one
project key: another key never sees it, and saving or removing a key drops it. When Composio cannot be
reached the last catalog is served marked stale, or the starter list marked as a fallback.

What the page may promise about each app is kept apart:

  listed       it is in the catalog above (remote text, shown as plain text, never as instructions);
  connectable  `connection`: managed (Composio supplies the sign-in), no_auth, custom_auth (the owner would need
               an auth config of their own in Composio, which this app does not set up), or unknown;
  curated      `curated_tools`, derived from composio_tools.TOOLS (the one allowlist) for GitHub, Gmail and Calendar;
  agent use    `agent_actions`: curated (only those tools), generic (the two generic tools, every call approved) or
               unavailable (a shell, code or Composio itself; composio_generic.py).

Nothing here says an agent may use an app: that is each agent's own setting.
"""
import asyncio
import time
from dataclasses import dataclass

from app import composio_generic, composio_tools
from app.services.composio_client import ComposioClient, ComposioError, Toolkit

CACHE_SECONDS = 600
MAX_PAGES = 4
DEFAULT_LIMIT = 48
MAX_LIMIT = 100
MAX_CATEGORIES = 30

# Display text for the apps that have curated tools; it never decides what an agent may do.
APP_INFO: dict[str, dict[str, str]] = {
    "github": {"name": "GitHub", "category": "Developer Tools",
               "description": "Issues, pull requests, commits and files in your repositories."},
    "gmail": {"name": "Gmail", "category": "Communication",
              "description": "Search and read mail, and draft replies in your threads."},
    "googlecalendar": {"name": "Google Calendar", "category": "Productivity",
                       "description": "See and search your events, and add events to your own calendar."},
}

# Shown before a key is saved, and when Composio cannot be reached. Not the marketplace.
_STARTER = (
    ("slack", "Slack", "Communication", "Messages and channels."),
    ("notion", "Notion", "Productivity", "Pages and databases."),
    ("linear", "Linear", "Developer Tools", "Issues and project tracking."),
    ("googlesheets", "Google Sheets", "Productivity", "Read and update spreadsheets."),
    ("googledocs", "Google Docs", "Productivity", "Read and write documents."),
    ("googledrive", "Google Drive", "Productivity", "Browse and manage files."),
    ("discord", "Discord", "Communication", "Messages and channels."),
    ("hubspot", "HubSpot", "Sales & CRM", "Contacts, deals and companies."),
    ("jira", "Jira", "Developer Tools", "Issues and projects."),
    ("asana", "Asana", "Productivity", "Tasks and projects."),
    ("trello", "Trello", "Productivity", "Boards and cards."),
    ("airtable", "Airtable", "Productivity", "Bases and records."),
    ("dropbox", "Dropbox", "Productivity", "Files and folders."),
    ("stripe", "Stripe", "Payments", "Payments, customers and invoices."),
    ("sentry", "Sentry", "Developer Tools", "Errors and alerts."),
    ("posthog", "PostHog", "Analytics", "Analytics and feature flags."),
    ("twitter", "X (Twitter)", "Social", "Posts and timelines."),
    ("reddit", "Reddit", "Social", "Browse and post."),
    ("zapier", "Zapier", "Automation", "Connect thousands of apps."),
    ("salesforce", "Salesforce", "Sales & CRM", "Customer records."),
    ("figma", "Figma", "Design", "Files and comments."),
)


@dataclass(frozen=True)
class Loaded:
    identity: str
    at: float
    toolkits: tuple
    complete: bool
    stale: bool = False


_cache: Loaded | None = None
_lock = asyncio.Lock()


def invalidate() -> None:
    """Forget the cached catalog: the key was saved, replaced or removed."""
    global _cache
    _cache = None


def _card(slug: str, name: str, description: str, categories: list, icon: str | None, connection: str) -> dict:
    curated = slug in composio_tools.apps()
    info = APP_INFO.get(slug, {})
    if curated:
        agent_actions = "curated"
    elif composio_generic.blocked_app(slug):
        agent_actions = "unavailable"
    else:
        agent_actions = "generic"
    return {
        "app": slug,
        "name": info.get("name") or name,
        "description": info.get("description") or description,
        "categories": [info["category"]] if info.get("category") and not categories else categories,
        "icon": icon,
        "connection": connection,
        "agent_actions": agent_actions,
        "curated_tools": [{"name": tool.name, "kind": tool.kind, "description": tool.description}
                          for tool in composio_tools.TOOLS if tool.app == slug],
    }


def _connection(toolkit: Toolkit) -> str:
    if toolkit.no_auth:
        return "no_auth"
    return "managed" if toolkit.managed_auth else "custom_auth"


def starter_cards() -> list[dict]:
    """The bundled list: today's curated apps first, then common ones. Connection is unknown until Composio is asked."""
    rows = [(slug, info["name"], info["description"], info["category"]) for slug, info in APP_INFO.items()]
    rows += [(slug, name, description, category) for slug, name, category, description in _STARTER]
    return [_card(slug, name, description, [category], None, "unknown") for slug, name, description, category in rows]


async def load(client: ComposioClient) -> Loaded:
    """Composio's catalog for this key, from the cache when it is fresh. Raises ComposioError when there is neither a
    fresh nor an older copy for this key."""
    global _cache
    identity = client.identity()
    async with _lock:
        cached = _cache if _cache is not None and _cache.identity == identity else None
        if cached is not None and time.monotonic() - cached.at < CACHE_SECONDS:
            return cached
        try:
            found: dict[str, Toolkit] = {}
            cursor = None
            seen: set[str] = set()
            complete = False
            total = None
            for _ in range(MAX_PAGES):
                page = await client.toolkits(cursor)
                for item in page.items:
                    found.setdefault(item.slug, item)
                total = page.total_items or total
                if not page.next_cursor:
                    complete = True
                    break
                if page.next_cursor in seen:
                    break
                seen.add(page.next_cursor)
                cursor = page.next_cursor
            if not found:
                raise ComposioError("bad_response", "Composio sent an empty catalog.")
            if total is not None and len(found) < total:
                complete = False
            _cache = Loaded(identity, time.monotonic(), tuple(found.values()), complete)
            return _cache
        except ComposioError:
            if cached is not None:
                return Loaded(cached.identity, cached.at, cached.toolkits, cached.complete, stale=True)
            raise


def _cards(loaded: Loaded | None) -> list[dict]:
    """Every app card: curated ones first (always present, even when the catalog page that holds them was missed),
    then Composio's apps in its own order of use."""
    if loaded is None:
        return starter_cards()
    by_slug = {t.slug: t for t in loaded.toolkits}
    cards = []
    for slug in composio_tools.apps():
        toolkit = by_slug.get(slug)
        info = APP_INFO[slug]
        cards.append(_card(slug, info["name"], info["description"], [info["category"]], toolkit.logo if toolkit else None,
                           _connection(toolkit) if toolkit else "unknown"))
    for toolkit in loaded.toolkits:
        if toolkit.slug not in composio_tools.apps():
            cards.append(_card(toolkit.slug, toolkit.name, toolkit.description, list(toolkit.categories), toolkit.logo, _connection(toolkit)))
    return cards


def _matches(card: dict, words: list[str]) -> bool:
    text = f"{card['name']} {card['app']} {card['description']} {' '.join(card['categories'])}".lower()
    return all(word in text for word in words)


async def page(client: ComposioClient | None, *, search: str = "", category: str | None = None,
               cursor: str | None = None, limit: int = DEFAULT_LIMIT) -> dict:
    """One bounded page of the catalog. `source` is `composio` or `starter`; `stale`, `complete` and `error` say how far
    to trust it. The cursor is only an offset into this list."""
    loaded, error = None, None
    if client is not None:
        try:
            loaded = await load(client)
        except ComposioError as exc:
            error = exc.kind
    cards = _cards(loaded)
    words = [word for word in search.lower().split() if word][:6]
    matching = [card for card in cards if _matches(card, words)]
    counts: dict[str, int] = {}
    for card in matching:
        for name in card["categories"]:
            counts[name] = counts.get(name, 0) + 1
    chosen = [card for card in matching if category is None or category in card["categories"]]
    try:
        offset = max(0, int(cursor.removeprefix("o")) if cursor else 0)
    except ValueError:
        offset = 0
    limit = max(1, min(limit, MAX_LIMIT))
    shown = chosen[offset:offset + limit]
    more = offset + limit < len(chosen)
    return {
        "source": "composio" if loaded is not None else "starter",
        "complete": loaded.complete if loaded is not None else False,
        "stale": loaded.stale if loaded is not None else False,
        "error": error,
        "total": len(chosen),
        "next_cursor": f"o{offset + limit}" if more else None,
        "categories": [{"name": name, "count": count} for name, count in
                       sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))[:MAX_CATEGORIES]],
        "apps": shown,
    }


async def is_known(client: ComposioClient, slug: str) -> bool:
    """Whether Composio has an app with this name: from this key's catalog when it was loaded, else by asking for the app
    itself. False means Composio said there is none; a failure to ask raises ComposioError, never a guess."""
    cached = _cache if _cache is not None and _cache.identity == client.identity() else None
    if cached is not None and any(t.slug == slug for t in cached.toolkits):
        return True
    try:
        await client.toolkit(slug)
        return True
    except ComposioError as exc:
        if exc.kind == "not_found":
            return False
        raise
