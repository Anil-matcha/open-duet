import assert from "node:assert/strict";
import { test } from "node:test";
import { appLabel } from "./connected-apps.ts";
import {
  NO_FILTER, accountOnlyCard, agentActionsText, canConnect, cardState, connectedSlugs, connectionNote, filterActive, groupByCategory,
  mergeApps, pageQuery, sourceNotice, splitApps, toolCounts,
} from "./apps-catalog.ts";

const tool = (name, kind) => ({ name, kind, description: name });
const app = (slug, more = {}) => ({
  app: slug, name: slug[0].toUpperCase() + slug.slice(1), description: `About ${slug}.`, categories: ["Productivity"], icon: null,
  connection: "managed", agent_actions: "generic", curated_tools: [], ...more,
});
const github = app("github", { categories: ["Developer Tools"], agent_actions: "curated", curated_tools: [tool("a", "read"), tool("b", "read"), tool("c", "write")] });
const slack = app("slack", { categories: ["Communication"] });
const notion = app("notion");
const APPS = [github, slack, notion];
const account = (id, status, toolkit = "github") => ({ id, status, toolkit, alias: null, created_at: null, updated_at: null });
const page = (more = {}) => ({ source: "composio", complete: true, stale: false, error: null, total: 3, next_cursor: null, categories: [], apps: APPS, ...more });

test("the filter asks the server for search and category, and 'Connected' is decided here", () => {
  assert.deepEqual(pageQuery({ search: "  sl ", category: "Communication", connectedOnly: true }), { search: "sl", category: "Communication" });
  assert.equal(filterActive(NO_FILTER), false);
  assert.equal(filterActive({ ...NO_FILTER, search: " " }), false);
  assert.equal(filterActive({ ...NO_FILTER, connectedOnly: true }), true);
  assert.equal(filterActive({ ...NO_FILTER, category: "AI" }), true);
});

test("pages are appended and an app that comes twice is kept once", () => {
  assert.deepEqual(mergeApps([github], [slack, github, notion]).map((a) => a.app), ["github", "slack", "notion"]);
  assert.deepEqual(mergeApps([], []), []);
});

test("curated counts come from the catalog and a generic action is never called a read", () => {
  assert.deepEqual(toolCounts(github), { read: 2, write: 1 });
  assert.match(agentActionsText(github), /2 read tools and 1 that change things \(each asks you first\)/);
  assert.match(agentActionsText(app("x", { agent_actions: "curated", curated_tools: [tool("a", "read")] })), /1 read tool\./);
  assert.match(agentActionsText(slack), /with your approval on every call/);
  assert.doesNotMatch(agentActionsText(slack), /read/i);
  assert.match(agentActionsText(app("composio", { agent_actions: "unavailable" })), /Not available to agents/);
  assert.match(agentActionsText(accountOnlyCard("zoho", appLabel)), /checked with Composio/);
});

test("Connect is offered only for an app agents may ever use and Composio can sign in to", () => {
  assert.equal(canConnect(slack), true);
  assert.equal(canConnect(app("hubspot", { connection: "custom_auth" })), false);
  assert.equal(canConnect(app("composio", { agent_actions: "unavailable" })), false);
  assert.equal(canConnect(app("exa", { connection: "no_auth" })), true);
  assert.equal(canConnect(app("x", { connection: "unknown" })), true);
  assert.match(connectionNote(app("hubspot", { connection: "custom_auth" })), /auth config of your own/);
  assert.equal(connectionNote(slack), null);
});

test("a card is never 'ready' for a pending link, and a working account wins", () => {
  assert.equal(cardState(false, []), "no_key");
  assert.equal(cardState(false, [account("a", "ACTIVE")]), "no_key");
  assert.equal(cardState(true, []), "not_connected");
  assert.equal(cardState(true, [account("a", "INITIATED")]), "pending");
  assert.equal(cardState(true, [account("a", "INITIALIZING")]), "pending");
  assert.equal(cardState(true, [account("a", "FAILED")]), "failed");
  assert.equal(cardState(true, [account("a", "EXPIRED"), account("b", "INITIATED")]), "pending");
  assert.equal(cardState(true, [account("a", "FAILED"), account("b", "ACTIVE")]), "connected");
});

test("only working accounts count as connected", () => {
  assert.deepEqual([...connectedSlugs([account("a", "ACTIVE"), account("b", "INITIATED", "slack")])], ["github"]);
  assert.equal(connectedSlugs(null).size, 0);
});

test("connected apps come first from the accounts, wherever the catalog paging is, and no card is shown twice", () => {
  const accounts = [account("a", "ACTIVE", "slack"), account("b", "INITIATED", "zoho"), account("c", "ACTIVE", "slack")];
  const { connected, others } = splitApps(APPS, accounts, NO_FILTER, appLabel);
  assert.deepEqual(connected.map((a) => a.app), ["slack", "zoho"]);
  assert.deepEqual(others.map((a) => a.app), ["github", "notion"]);
  assert.equal(connected[1].agent_actions, "unknown");   // the catalog does not list it: an account card only
  assert.equal(connected[1].name, "Zoho");
});

test("an account is never hidden because its app is missing from the loaded pages", () => {
  const { connected } = splitApps([], [account("a", "ACTIVE", "zoho"), account("b", "FAILED", "airtable")], NO_FILTER, appLabel);
  assert.deepEqual(connected.map((a) => a.app), ["airtable", "zoho"]);
  assert.deepEqual(splitApps([], null, NO_FILTER, appLabel), { connected: [], others: [] });
});

test("the filter narrows connected apps too, and 'Connected' hides the rest", () => {
  const accounts = [account("a", "ACTIVE", "slack"), account("b", "ACTIVE", "zoho")];
  assert.deepEqual(splitApps(APPS, accounts, { ...NO_FILTER, search: "zo" }, appLabel).connected.map((a) => a.app), ["zoho"]);
  assert.deepEqual(splitApps(APPS, accounts, { ...NO_FILTER, category: "Communication" }, appLabel).connected.map((a) => a.app), ["slack"]);
  const only = splitApps(APPS, accounts, { ...NO_FILTER, connectedOnly: true }, appLabel);
  assert.deepEqual(only.connected.map((a) => a.app), ["slack", "zoho"]);
  assert.deepEqual(only.others, []);
});

test("apps are grouped by their first category in the order they arrive", () => {
  const groups = groupByCategory([github, slack, notion, app("airtable"), app("loose", { categories: [] })]);
  assert.deepEqual(groups.map((g) => [g.category, g.apps.map((a) => a.app)]), [
    ["Developer Tools", ["github"]], ["Communication", ["slack"]], ["Productivity", ["notion", "airtable"]], ["Other", ["loose"]],
  ]);
});

test("the page says where the list came from and how far to trust it", () => {
  assert.equal(sourceNotice(page(), true), null);
  assert.match(sourceNotice(page({ source: "starter" }), false).text, /Add your Composio key/);
  assert.match(sourceNotice(page({ source: "starter" }), true).text, /only the starter list/);
  assert.match(sourceNotice(page({ source: "starter", error: "key_rejected" }), true).text, /did not accept your key/);
  assert.match(sourceNotice(page({ source: "starter", error: "unavailable" }), true).text, /Could not reach Composio/);
  assert.equal(sourceNotice(page({ source: "starter", error: "unavailable" }), true).tone, "warning");
  assert.match(sourceNotice(page({ stale: true }), true).text, /out of date/);
  assert.match(sourceNotice(page({ complete: false }), true).text, /partly loaded/);
});
