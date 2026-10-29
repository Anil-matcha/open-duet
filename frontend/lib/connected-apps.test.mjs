import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_APPS, GENERIC_READ, GENERIC_WRITE, accountsOf, agentAppOptions, appLabel, isComposioLink, levelOf, outcomeFor, pollDeadline, reservePage, scopesToSend, statusLabel, supportsConnectedApps, withApp } from "./connected-apps.ts";

const LINK = "https://connect.composio.dev/link/lk_abc";
const account = (id, status, toolkit = "github") => ({ id, status, toolkit, alias: null, created_at: null, updated_at: null });

test("only https links on composio.dev count as Composio links", () => {
  assert.equal(isComposioLink(LINK), true);
  assert.equal(isComposioLink("https://composio.dev/x"), true);
  for (const bad of [
    "http://connect.composio.dev/x", "https://composio.dev.evil.test/x", "https://evilcomposio.dev/x",
    "https://connect.composio.dev@evil.test/x", "https://u:p@connect.composio.dev/x", "https://connect.composio.dev:8443/x",
    "javascript:alert(1)", "https://connect.composio.dev/a b", "", null, undefined, 7, {},
  ]) assert.equal(isComposioLink(bad), false, String(bad));
});

test("each status has a plain label and unknown ones still read", () => {
  assert.equal(statusLabel("ACTIVE"), "Connected");
  assert.match(statusLabel("INITIATED"), /Waiting/);
  assert.equal(statusLabel("FAILED"), "Connection failed");
  assert.equal(statusLabel("EXPIRED"), "Link expired");
  assert.equal(statusLabel("SOMETHING_NEW"), "Something_new");
});

test("the account being waited for decides the outcome", () => {
  assert.equal(outcomeFor([account("a", "ACTIVE")], "a"), "connected");
  assert.equal(outcomeFor([account("a", "INITIATED")], "a"), "waiting");
  assert.equal(outcomeFor([account("a", "INITIALIZING")], "a"), "waiting");
  assert.equal(outcomeFor([account("a", "FAILED")], "a"), "failed");
  assert.equal(outcomeFor([account("a", "EXPIRED")], "a"), "failed");
  assert.equal(outcomeFor([account("b", "ACTIVE")], "a"), "gone");
  assert.equal(outcomeFor([], "a"), "gone");
});

test("waiting ends a little after the link does and never runs unbounded", () => {
  assert.equal(pollDeadline(600, 1000), 1000 + 615_000);
  assert.equal(pollDeadline(0, 0), 615_000);
  assert.equal(pollDeadline(Number.NaN, 0), 615_000);
  assert.equal(pollDeadline(10_000_000, 0), 3615_000);
});

test("accounts are grouped by app", () => {
  const all = [account("a", "ACTIVE"), account("b", "ACTIVE", "gmail"), account("c", "INITIATED")];
  assert.deepEqual(accountsOf(all, "github").map((a) => a.id), ["a", "c"]);
  assert.deepEqual(accountsOf(all, "slack"), []);
});

test("in a browser the tab opens during the click and goes to the link later", async () => {
  const opened = [];
  const tab = { opener: "page", closed: false, location: { href: "about:blank" }, close() { this.closed = true; } };
  const page = reservePage(undefined, (url, target) => { opened.push([url, target]); return tab; });
  assert.deepEqual(opened, [["about:blank", "_blank"]]);
  assert.equal(tab.opener, null);
  await page.navigate(LINK);
  assert.equal(tab.location.href, LINK);
});

test("a link that is not Composio's closes the reserved tab and is never opened", async () => {
  const tab = { opener: "page", closed: false, location: { href: "about:blank" }, close() { this.closed = true; } };
  const page = reservePage(undefined, () => tab);
  await assert.rejects(page.navigate("https://evil.test/x"));
  assert.equal(tab.closed, true);
  assert.equal(tab.location.href, "about:blank");
});

test("a blocked pop-up is reported, and cancel closes an unused tab", async () => {
  await assert.rejects(reservePage(undefined, () => null).navigate(LINK), /blocked/);
  const tab = { opener: null, closed: false, location: { href: "about:blank" }, close() { this.closed = true; } };
  reservePage(undefined, () => tab).cancel();
  assert.equal(tab.closed, true);
});

test("the desktop app opens the link through its shell and opens no tab", async () => {
  const sent = [];
  let tabs = 0;
  const page = reservePage({ openComposioLink: async (url) => { sent.push(url); } }, () => { tabs += 1; return null; });
  await page.navigate(LINK);
  assert.deepEqual(sent, [LINK]);
  assert.equal(tabs, 0);
  await assert.rejects(page.navigate("https://evil.test/x"));
  assert.deepEqual(sent, [LINK]);
});

test("an app gets a level or is removed, without touching the others", () => {
  assert.deepEqual(withApp(null, "github", "read"), { github: "read" });
  assert.deepEqual(withApp({ github: "read" }, "github", "write"), { github: "write" });
  assert.deepEqual(withApp({ github: "write" }, "github", "off"), {});
  assert.deepEqual(withApp({ other: "read" }, "github", "write"), { other: "read", github: "write" });
  const before = { github: "read" };
  withApp(before, "github", "off");
  assert.deepEqual(before, { github: "read" });
});

test("a level is read back as off unless it is a known one", () => {
  assert.equal(levelOf({ github: "read" }, "github"), "read");
  assert.equal(levelOf({ github: "write" }, "github"), "write");
  for (const odd of [{ github: "admin" }, { github: "" }, {}, null, undefined]) assert.equal(levelOf(odd, "github"), "off");
  assert.equal(levelOf({ gmail: "read" }, "github"), "off");
});

test("saving sends known levels for engines that support apps", () => {
  assert.deepEqual(scopesToSend({ github: "read" }, "claude"), { github: "read" });
  assert.deepEqual(scopesToSend({ github: "write" }, "claude"), { github: "write" });
  assert.deepEqual(scopesToSend({ github: "write", gmail: "read" }, "codex"), { github: "write", gmail: "read" });
  assert.equal(scopesToSend({}, "claude"), null);
  assert.equal(scopesToSend(null, "claude"), null);
  assert.equal(scopesToSend({ github: "write" }, "openai_compat"), null);
  assert.deepEqual(scopesToSend({ github: "write", gmail: "read", slack: "write" }, "claude"), { github: "write", gmail: "read", slack: "write" });
  assert.deepEqual(scopesToSend({ googlecalendar: "write", notion: "read" }, "codex"), { googlecalendar: "write", notion: "read" });
  assert.equal(scopesToSend({ "Bad Name": "read", "../x": "read", "": "read", ["a".repeat(65)]: "read" }, "claude"), null);
  assert.equal(scopesToSend({ github: "admin" }, "claude"), null);
  assert.equal(supportsConnectedApps("codex"), true);
  assert.equal(supportsConnectedApps("openai_compat"), false);
  assert.ok(AGENT_APPS.every((app) => app.slug && app.label && app.read && (app.write === null || typeof app.write === 'string')));
});

test("a name that is not an app's, or a level that is not one, is never sent", () => {
  assert.equal(scopesToSend({ Slack: "read" }, "claude"), null);
  assert.equal(scopesToSend({ slack: "admin" }, "claude"), null);
  assert.equal(scopesToSend({ slack: true }, "claude"), null);
});

test("an app name Composio writes becomes a readable label", () => {
  assert.equal(appLabel("slack"), "Slack");
  assert.equal(appLabel("google_sheets"), "Google sheets");
  assert.equal(appLabel("ms-teams"), "Ms teams");
});

test("an agent can be given the curated apps, then every other app with an account or already allowed", () => {
  const accounts = [account("a", "ACTIVE", "slack"), account("b", "INITIATED", "notion"), account("c", "ACTIVE", "slack"), account("d", "ACTIVE", "github")];
  const options = agentAppOptions(accounts, { zoho: "read", github: "read" }, { slack: "Slack" });
  assert.deepEqual(options.map((o) => o.slug), ["github", "gmail", "googlecalendar", "notion", "slack", "zoho"]);
  const bySlug = Object.fromEntries(options.map((o) => [o.slug, o]));
  assert.equal(bySlug.github.generic, false);
  assert.equal(bySlug.slack.generic, true);
  assert.equal(bySlug.slack.label, "Slack");
  assert.equal(bySlug.zoho.label, "Zoho");
  assert.equal(bySlug.slack.read, GENERIC_READ);
  assert.equal(bySlug.slack.write, GENERIC_WRITE);
  assert.match(GENERIC_WRITE, /approve every call/);
  assert.deepEqual(agentAppOptions(null, null).map((o) => o.slug), ["github", "gmail", "googlecalendar"]);
  assert.deepEqual(agentAppOptions([account("a", "ACTIVE", "Bad Name")], { "../x": "read" }).map((o) => o.slug), ["github", "gmail", "googlecalendar"]);
});
