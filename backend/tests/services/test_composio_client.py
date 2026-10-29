"""The Composio client against a fake: what it keeps, what it drops, how it fails."""
import httpx
import pytest

from app.services.composio_client import ComposioClient, ComposioError, trusted_link

TOKEN = "gho_SECRET_OAUTH_TOKEN"


def client_for(handler) -> ComposioClient:
    return ComposioClient("ak_abcdef123456", transport=httpx.MockTransport(handler))


@pytest.mark.parametrize("url, ok", [
    ("https://connect.composio.dev/link/lk_x", True),
    ("https://composio.dev/x", True),
    ("https://backend.composio.dev:443/x", True),
    ("http://connect.composio.dev/x", False),
    ("https://composio.dev.evil.example/x", False),
    ("https://evilcomposio.dev/x", False),
    ("https://connect.composio.dev@evil.example/x", False),
    ("https://user:pw@connect.composio.dev/x", False),
    ("https://connect.composio.dev:8443/x", False),
    ("ftp://connect.composio.dev/x", False),
    ("https://connect.composio.dev/" + "a" * 5000, False),
    ("", False), (None, False), (42, False),
])
def test_only_https_links_on_composio_dev_are_trusted(url, ok):
    result = trusted_link(url)
    assert (result is not None) is ok
    assert result in (None, url)


async def test_an_account_is_reduced_to_display_fields():
    def handler(request):
        return httpx.Response(200, json={"items": [{
            "id": "ca_1", "toolkit": {"slug": "github"}, "alias": "work", "status": "active", "user_id": "u1",
            "data": {"access_token": TOKEN}, "state": {"val": {"access_token": TOKEN}},
            "created_at": "c", "updated_at": "u", "auth_config": {"id": "ac_1"},
        }]})

    (account,) = await client_for(handler).accounts("u1")
    assert vars(account) == {"id": "ca_1", "toolkit": "github", "alias": "work", "status": "ACTIVE",
                             "created_at": "c", "updated_at": "u"}
    assert TOKEN not in repr(account)


async def test_rows_for_another_user_or_without_a_usable_id_are_dropped():
    def handler(request):
        return httpx.Response(200, json={"items": [
            {"id": "ca_1", "toolkit": {"slug": "github"}, "user_id": "someone-else"},
            {"id": "bad id!", "toolkit": {"slug": "github"}, "user_id": "u1"},
            {"id": "ca_3", "toolkit": "github", "user_id": "u1"},
            "not a dict",
            {"id": "ca_4", "toolkit": {"slug": "gmail"}},
        ]})

    assert [a.id for a in await client_for(handler).accounts("u1")] == ["ca_4"]


async def test_accounts_follow_the_cursor_with_a_page_limit():
    seen = []

    def handler(request):
        seen.append(request.url.params.get("cursor"))
        n = len(seen)
        return httpx.Response(200, json={
            "items": [{"id": f"ca_{n}", "toolkit": {"slug": "github"}}], "next_cursor": f"c{n}",
        })

    found = await client_for(handler).accounts("u1")
    assert len(found) == 5 and seen[0] is None and seen[1] == "c1"


@pytest.mark.parametrize("status, kind", [
    (401, "key_rejected"), (403, "permission_denied"), (404, "not_found"), (429, "rate_limited"),
    (500, "unavailable"), (502, "unavailable"), (400, "rejected"), (409, "rejected"),
])
async def test_errors_are_classified(status, kind):
    def handler(request):
        return httpx.Response(status, json={"error": {"message": "short reason"}})

    with pytest.raises(ComposioError) as caught:
        await client_for(handler).accounts("u1")
    assert caught.value.kind == kind


async def test_a_message_is_bounded_and_the_key_is_not_added():
    def handler(request):
        return httpx.Response(400, json={"error": {"message": "x" * 5000}})

    with pytest.raises(ComposioError) as caught:
        await client_for(handler).accounts("u1")
    assert len(caught.value.message) == 200 and "ak_abcdef123456" not in caught.value.message


async def test_network_failures_and_junk_answers_do_not_leak_details():
    def down(request):
        raise httpx.ConnectError("could not connect to ak_abcdef123456 at host")

    with pytest.raises(ComposioError) as caught:
        await client_for(down).accounts("u1")
    assert caught.value.kind == "unavailable" and "ak_" not in caught.value.message

    with pytest.raises(ComposioError) as caught:
        await client_for(lambda request: httpx.Response(200, content=b"<html>")).accounts("u1")
    assert caught.value.kind == "bad_response"

    with pytest.raises(ComposioError) as caught:
        await client_for(lambda request: httpx.Response(200, content=b"x" * 2_000_001)).accounts("u1")
    assert caught.value.kind == "bad_response"


async def test_redirects_are_not_followed():
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(302, headers={"location": "https://evil.example/steal"})

    with pytest.raises(ComposioError):
        await client_for(handler).accounts("u1")
    assert calls and all("evil.example" not in c for c in calls)


async def test_the_key_goes_only_in_the_header():
    seen = {}

    def handler(request):
        seen.update(headers=dict(request.headers), url=str(request.url), body=request.content)
        return httpx.Response(200, json={"items": []})

    await client_for(handler).accounts("u1", "github")
    assert seen["headers"]["x-api-key"] == "ak_abcdef123456"
    assert "ak_abcdef" not in seen["url"] and b"ak_abcdef" not in seen["body"]
    assert "toolkit_slugs=github" in seen["url"] and "user_ids=u1" in seen["url"]


async def test_a_session_or_link_without_the_expected_fields_is_refused():
    with pytest.raises(ComposioError) as caught:
        await client_for(lambda r: httpx.Response(201, json={"session_id": "has space"})).create_session("u1")
    assert caught.value.kind == "bad_response"
    with pytest.raises(ComposioError):
        await client_for(lambda r: httpx.Response(201, json={"redirect_url": "https://connect.composio.dev/x"})).link("s_1", "github", "a")


async def test_delete_refuses_an_unsafe_id_before_any_request():
    calls = []
    client = client_for(lambda r: calls.append(r) or httpx.Response(200, json={}))
    with pytest.raises(ComposioError):
        await client.delete_account("../tool_router/session/s_1")
    assert calls == []


# -- the catalog and tool calls ------------------------------------------------------------------------------------------

def test_a_toolkit_is_reduced_to_display_fields_and_a_logo_off_composio_is_dropped():
    from app.services.composio_client import _toolkit
    item = {"slug": "Slack", "name": "Slack", "no_auth": False, "composio_managed_auth_schemes": ["oauth2"], "secret": TOKEN,
            "meta": {"description": "d" * 400, "logo": "https://evil.example/l.png", "tools_count": 12,
                     "categories": [{"id": "a", "name": "Communication"}, "Productivity", {"id": "x"}, {"name": " "}]}}
    found = _toolkit(item)
    assert (found.slug, found.logo, found.managed_auth, found.no_auth, found.tools_count) == ("slack", None, True, False, 12)
    assert found.categories == ("Communication", "Productivity") and len(found.description) == 300 and TOKEN not in repr(found)
    assert _toolkit({"slug": "../x"}) is None and _toolkit({"name": "x"}) is None and _toolkit("x") is None
    assert _toolkit({"slug": "a", "meta": {"logo": "https://assets.composio.dev/l.png"}}).logo == "https://assets.composio.dev/l.png"


def tool_json(slug="NOTION_CREATE_PAGE", toolkit="notion", **more):
    return {"slug": slug, "name": "Create page", "description": "d", "toolkit": {"slug": toolkit}, "version": "v1", "tags": ["a", 3],
            "input_parameters": {"type": "object"}, "is_deprecated": False, **more}


async def test_tools_keep_only_those_of_the_asked_app_and_the_schema_only_when_it_is_small():
    from app.services.composio_client import MAX_SCHEMA_BYTES
    seen = []

    def handler(request):
        seen.append((request.url.path.removeprefix("/api/v3.1"), dict(request.url.params)))
        return httpx.Response(200, json={"items": [tool_json(), tool_json("SLACK_X", "slack"), tool_json("NOTION_BIG", input_parameters={"x": "y" * MAX_SCHEMA_BYTES}),
                                                   {"slug": "bad slug", "toolkit": {"slug": "notion"}}], "next_cursor": "c2"})

    page = await client_for(handler).tools("notion", "pages", None, 5)
    assert seen == [("/tools", {"toolkit_slug": "notion", "limit": "5", "query": "pages"})]
    assert [t.slug for t in page.items] == ["NOTION_CREATE_PAGE", "NOTION_BIG"] and page.next_cursor == "c2"
    assert page.items[0].schema == {"type": "object"} and page.items[0].tags == ("a",) and page.items[1].schema is None


async def test_one_tool_must_be_the_one_asked_for():
    def handler(request):
        slug = request.url.path.rsplit("/", 1)[1]
        return httpx.Response(200, json=tool_json("OTHER_TOOL" if slug == "NOTION_WANTED" else slug))

    client = client_for(handler)
    assert (await client.tool("NOTION_CREATE_PAGE")).slug == "NOTION_CREATE_PAGE"
    for bad in ("NOTION_WANTED", "lower_case", "A/B", "X" * 200):
        with pytest.raises(ComposioError) as caught:
            await client.tool(bad)
        assert caught.value.kind == "not_found"


async def test_a_toolkit_must_be_the_one_asked_for_and_a_missing_one_is_not_found():
    def handler(request):
        slug = request.url.path.rsplit("/", 1)[1]
        return httpx.Response(404, json={"error": {"message": "x"}}) if slug == "gone" else httpx.Response(200, json={"slug": "other", "name": "O", "meta": {}})

    client = client_for(handler)
    for slug in ("gone", "wanted", "Bad Name", "../x"):
        with pytest.raises(ComposioError) as caught:
            await client.toolkit(slug)
        assert caught.value.kind == "not_found"


def test_the_client_identity_tells_projects_apart_and_does_not_contain_the_key():
    a, b = ComposioClient("ak_ONE_abcdef123456"), ComposioClient("ak_TWO_abcdef123456")
    assert a.identity() == ComposioClient("ak_ONE_abcdef123456").identity() != b.identity()
    assert "ONE" not in a.identity() and a.identity() != ComposioClient("ak_ONE_abcdef123456", base_url="https://other.example/").identity()
