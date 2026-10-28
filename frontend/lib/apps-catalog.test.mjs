import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_FILTER, cardState, categoriesOf, connectedSlugs, filterActive, filterApps, toolCounts, unsupportedAccounts } from "./apps-catalog.ts";

const tool = (name, kind) => ({ name, kind, description: name });
const APPS = [
  { app: "github", name: "GitHub", description: "Issues and pull requests.", category: "Developer tools", tools: [tool("a", "read"), tool("b", "read"), tool("c", "write")] },
  { app: "gmail", name: "Gmail", description: "Search mail and draft replies.", category: "Communication", tools: [tool("d", "read")] },
  { app: "googlecalendar", name: "Google Calendar", description: "Your events.", category: "Productivity", tools: [tool("e", "read")] },
];
const account = (id, status, toolkit = "github") => ({ id, status, toolkit, alias: null, created_at: null, updated_at: null });

test("categories are unique and sorted", () => {
  assert.deepEqual(categoriesOf(APPS), ["Communication", "Developer tools", "Productivity"]);
  assert.deepEqual(categoriesOf([]), []);
});

test("search needs every word and also reads the description and category", () => {
  const names = (filter) => filterApps(APPS, { ...NO_FILTER, ...filter }, new Set()).map((app) => app.app);
  assert.deepEqual(names({}), ["github", "gmail", "googlecalendar"]);
  assert.deepEqual(names({ search: "  GIT " }), ["github"]);
  assert.deepEqual(names({ search: "mail draft" }), ["gmail"]);
  assert.deepEqual(names({ search: "communication" }), ["gmail"]);
  assert.deepEqual(names({ search: "mail calendar" }), []);
});

test("category and connected filters combine with search", () => {
  const connected = new Set(["gmail", "github"]);
  const names = (filter) => filterApps(APPS, { ...NO_FILTER, ...filter }, connected).map((app) => app.app);
  assert.deepEqual(names({ connectedOnly: true }), ["github", "gmail"]);
  assert.deepEqual(names({ connectedOnly: true, category: "Communication" }), ["gmail"]);
  assert.deepEqual(names({ category: "Productivity", connectedOnly: true }), []);
  assert.equal(filterActive(NO_FILTER), false);
  assert.equal(filterActive({ ...NO_FILTER, search: " " }), false);
  assert.equal(filterActive({ ...NO_FILTER, connectedOnly: true }), true);
});

test("tool counts come from the catalog", () => {
  assert.deepEqual(toolCounts(APPS[0]), { read: 2, write: 1 });
  assert.deepEqual(toolCounts(APPS[2]), { read: 1, write: 0 });
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
  assert.deepEqual([...connectedSlugs([account("a", "ACTIVE"), account("b", "INITIATED", "gmail")])], ["github"]);
  assert.equal(connectedSlugs(null).size, 0);
});

test("accounts of an app with no agent tools are set apart", () => {
  const stray = account("x", "ACTIVE", "slack");
  assert.deepEqual(unsupportedAccounts([account("a", "ACTIVE"), stray], APPS), [stray]);
});
