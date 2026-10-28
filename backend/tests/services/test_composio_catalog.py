"""The app catalog the Apps page lists: starter list, Composio's catalog read with the owner's key, cache and its isolation."""
import httpx
import pytest

from app import composio_catalog as catalog
from app import composio_tools
from app.services import composio_service
from app.services.composio_client import ComposioClient, ComposioError


def toolkit(slug, name=None, *, categories=("Productivity",), managed=True, no_auth=False, logo="https://logos.composio.dev/api/x.png", tools=5):
    return {"slug": slug, "name": name or slug.title(), "type": "native", "no_auth": no_auth, "auth_schemes": ["oauth2"],
            "composio_managed_auth_schemes": ["oauth2"] if managed else [], "is_local_toolkit": False, "deprecated": {"toolkitId": slug},
            "meta": {"description": f"About {slug}.", "logo": logo, "categories": [{"id": c.lower(), "name": c} for c in categories],
                     "tools_count": tools, "triggers_count": 0, "version": "1", "created_at": "", "updated_at": ""}}


class FakeCatalog:
    def __init__(self, pages):
        self.pages = pages                      # list of lists of toolkit items, one per page
        self.calls: list[str] = []
        self.fail: int | None = None
        self.total_items: int | None = None
        self.stuck = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        route = f"{request.method} {request.url.path.removeprefix('/api/v3.1')}"
        self.calls.append(route)
        if self.fail:
            return httpx.Response(self.fail, json={"error": {"message": "boom"}})
        if route == "GET /toolkits":
            cursor = request.url.params.get("cursor")
            index = int(cursor) if cursor else 0
            nxt = None if index + 1 >= len(self.pages) else str(index if self.stuck else index + 1)
            body = {"items": self.pages[index], "next_cursor": nxt, "current_page": index + 1, "total_pages": len(self.pages),
                    "total_items": self.total_items or sum(len(p) for p in self.pages)}
            return httpx.Response(200, json=body)
        if route.startswith("GET /toolkits/"):
            slug = route.rsplit("/", 1)[1]
            for page in self.pages:
                for item in page:
                    if item["slug"] == slug:
                        return httpx.Response(200, json=item)
            return httpx.Response(404, json={"error": {"message": "no such app"}})
        return httpx.Response(404, json={"error": {"message": route}})

    def client(self, key="ak_PROJECTKEY_aaaaaa111111") -> ComposioClient:
        return ComposioClient(key, transport=httpx.MockTransport(self.handler))

    @property
    def toolkit_calls(self) -> int:
        return len([c for c in self.calls if c == "GET /toolkits"])


@pytest.fixture(autouse=True)
def fresh_cache():
    catalog.invalidate()
    yield
    catalog.invalidate()


def slugs(page):
    return [card["app"] for card in page["apps"]]


# -- the list is derived from the one allowlist ----------------------------------------------------------------

def test_every_curated_app_has_display_text_and_its_tools_come_from_the_allowlist():
    assert set(composio_tools.apps()) == set(catalog.APP_INFO)
    for card in catalog.starter_cards()[:3]:
        expected = [(tool.name, tool.kind) for tool in composio_tools.TOOLS if tool.app == card["app"]]
        assert [(t["name"], t["kind"]) for t in card["curated_tools"]] == expected and card["agent_actions"] == "curated"


def test_the_apps_connect_always_accepts_include_the_curated_ones():
    assert {slug for slug, _ in composio_service.SUPPORTED_APPS} == set(composio_tools.apps())


# -- without a key ----------------------------------------------------------------------------------------------------

async def test_without_a_key_the_page_gets_a_starter_list_that_says_so():
    page = await catalog.page(None)
    assert page["source"] == "starter" and page["complete"] is False and page["stale"] is False and page["error"] is None
    assert slugs(page)[:3] == ["github", "gmail", "googlecalendar"] and "slack" in slugs(page) and "notion" in slugs(page)
    by = {card["app"]: card for card in page["apps"]}
    assert by["slack"]["agent_actions"] == "generic" and by["slack"]["curated_tools"] == [] and by["slack"]["connection"] == "unknown"
    assert by["github"]["agent_actions"] == "curated" and all(card["icon"] is None for card in page["apps"])


async def test_search_category_and_paging_work_on_the_starter_list():
    assert slugs(await catalog.page(None, search="  SLACK ")) == ["slack"]
    assert "gmail" in slugs(await catalog.page(None, search="mail draft"))
    assert slugs(await catalog.page(None, search="nothing like this")) == []
    dev = await catalog.page(None, category="Developer Tools")
    assert {"github", "linear"} <= set(slugs(dev)) and "gmail" not in slugs(dev)
    first = await catalog.page(None, limit=5)
    assert len(first["apps"]) == 5 and first["next_cursor"] == "o5" and first["total"] == 24
    second = await catalog.page(None, limit=5, cursor=first["next_cursor"])
    assert slugs(second) == slugs(await catalog.page(None, limit=10))[5:]
    last = await catalog.page(None, limit=5, cursor="o20")
    assert len(last["apps"]) == 4 and last["next_cursor"] is None
    assert (await catalog.page(None, cursor="junk"))["apps"][0]["app"] == "github"
    assert len((await catalog.page(None, limit=10_000))["apps"]) == 24   # one page is bounded


async def test_category_chips_count_what_the_search_matches_not_the_chosen_category():
    page = await catalog.page(None, search="issues", category="Developer Tools")
    names = {c["name"]: c["count"] for c in page["categories"]}
    assert names["Developer Tools"] >= 3 and "Communication" not in names


# -- with Composio's own catalog -----------------------------------------------------------------------------------------

def sample():
    fake = FakeCatalog([
        [toolkit("slack", "Slack", categories=("Communication",)), toolkit("notion", "Notion"), toolkit("hubspot", "HubSpot", managed=False, categories=("Sales & CRM",))],
        [toolkit("exa", "Exa", no_auth=True, categories=("Analytics", "AI")), toolkit("composio", "Composio"), toolkit("slack", "Slack again")],
    ])
    fake.total_items = 5                       # Composio counts each app once; the repeated slack is dropped
    return fake


async def test_the_catalog_is_composios_own_read_across_pages_with_curated_apps_first():
    fake = sample()
    page = await catalog.page(fake.client())
    assert page["source"] == "composio" and page["complete"] is True and page["stale"] is False and page["error"] is None
    assert slugs(page) == ["github", "gmail", "googlecalendar", "slack", "notion", "hubspot", "exa", "composio"]   # curated even though Composio's pages lack them
    by = {card["app"]: card for card in page["apps"]}
    assert by["slack"]["name"] == "Slack" and by["slack"]["connection"] == "managed" and by["slack"]["categories"] == ["Communication"]
    assert by["hubspot"]["connection"] == "custom_auth" and by["exa"]["connection"] == "no_auth" and by["exa"]["categories"] == ["Analytics", "AI"]
    assert by["notion"]["icon"] == "https://logos.composio.dev/api/x.png" and by["notion"]["description"] == "About notion."
    assert by["composio"]["agent_actions"] == "unavailable" and by["notion"]["agent_actions"] == "generic"
    assert by["github"]["agent_actions"] == "curated" and by["github"]["curated_tools"]
    assert fake.toolkit_calls == 2


async def test_a_logo_off_composio_is_not_passed_on():
    fake = FakeCatalog([[toolkit("a1", logo="https://evil.example/x.png"), toolkit("b1", logo="http://logos.composio.dev/x.png"),
                         toolkit("c1", logo="https://user:pw@logos.composio.dev/x.png"), toolkit("d1", logo="https://composio.dev.evil.example/x.png"),
                         toolkit("e1", logo="https://assets.composio.dev/logos/e.png")]])
    icons = {card["app"]: card["icon"] for card in (await catalog.page(fake.client()))["apps"]}
    assert icons["a1"] is icons["b1"] is icons["c1"] is icons["d1"] is None and icons["e1"] == "https://assets.composio.dev/logos/e.png"


async def test_the_catalog_is_cached_per_key_and_dropped_when_the_key_changes():
    fake = sample()
    await catalog.page(fake.client("ak_ONE_aaaaaa111111"))
    await catalog.page(fake.client("ak_ONE_aaaaaa111111"), search="slack")
    assert fake.toolkit_calls == 2                                   # the second page() read the cache
    await catalog.page(fake.client("ak_TWO_bbbbbb222222"))
    assert fake.toolkit_calls == 4                                   # another project's key never sees the first catalog
    await catalog.page(fake.client("ak_TWO_bbbbbb222222"))
    assert fake.toolkit_calls == 4
    catalog.invalidate()
    await catalog.page(fake.client("ak_TWO_bbbbbb222222"))
    assert fake.toolkit_calls == 6


async def test_the_cache_expires(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(catalog.time, "monotonic", lambda: now[0])
    fake = sample()
    await catalog.page(fake.client())
    now[0] += catalog.CACHE_SECONDS - 1
    await catalog.page(fake.client())
    assert fake.toolkit_calls == 2
    now[0] += 2
    await catalog.page(fake.client())
    assert fake.toolkit_calls == 4


async def test_when_composio_fails_the_last_catalog_is_served_marked_stale(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(catalog.time, "monotonic", lambda: now[0])
    fake = sample()
    await catalog.page(fake.client())
    now[0] += catalog.CACHE_SECONDS + 5
    fake.fail = 503
    page = await catalog.page(fake.client())
    assert page["source"] == "composio" and page["stale"] is True and "slack" in slugs(page)


async def test_with_no_catalog_at_all_a_failure_falls_back_to_the_starter_list_and_names_the_cause():
    fake = sample()
    fake.fail = 401
    page = await catalog.page(fake.client())
    assert page["source"] == "starter" and page["error"] == "key_rejected" and page["complete"] is False
    fake.fail = 503
    assert (await catalog.page(fake.client("ak_OTHER_cccccc333333")))["error"] == "unavailable"
    fake.fail = None
    assert (await catalog.page(fake.client("ak_OTHER_cccccc333333")))["source"] == "composio"   # and recovers


async def test_paging_that_stalls_or_falls_short_is_reported_as_partial():
    stuck = sample()
    stuck.stuck = True
    page = await catalog.page(stuck.client())
    assert page["source"] == "composio" and page["complete"] is False
    short = sample()
    short.total_items = 400
    assert (await catalog.page(short.client("ak_SHORT_dddddd444444")))["complete"] is False


async def test_an_empty_catalog_is_not_trusted():
    fake = FakeCatalog([[]])
    page = await catalog.page(fake.client())
    assert page["source"] == "starter" and page["error"] == "bad_response"


async def test_search_and_categories_work_on_composios_catalog():
    fake = sample()
    assert slugs(await catalog.page(fake.client(), search="sales")) == ["hubspot"]
    assert slugs(await catalog.page(fake.client(), category="AI")) == ["exa"]
    names = {c["name"] for c in (await catalog.page(fake.client()))["categories"]}
    assert {"Communication", "Productivity", "Sales & CRM", "Analytics", "AI", "Developer Tools"} <= names


# -- is an app one Composio lists? ----------------------------------------------------------------------------------------------

async def test_an_app_is_known_from_the_loaded_catalog_or_by_asking_for_it():
    fake = sample()
    client = fake.client()
    assert await catalog.is_known(client, "exa") is True and fake.calls == ["GET /toolkits/exa"]   # not loaded yet: asked directly
    await catalog.page(client)
    fake.calls.clear()
    assert await catalog.is_known(client, "notion") is True and fake.calls == []                    # loaded: no request
    assert await catalog.is_known(client, "made_up_app") is False and fake.calls == ["GET /toolkits/made_up_app"]


async def test_failing_to_ask_is_an_error_never_a_guess():
    fake = sample()
    fake.fail = 503
    with pytest.raises(ComposioError) as caught:
        await catalog.is_known(fake.client(), "notion")
    assert caught.value.kind == "unavailable"
