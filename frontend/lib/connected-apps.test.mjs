import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_APPS, accountsOf, isComposioLink, outcomeFor, pollDeadline, reservePage, scopesToSend, statusLabel, withApp } from "./connected-apps.ts";

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

test("an app is allowed for reading or removed, without touching the others", () => {
  assert.deepEqual(withApp(null, "github", true), { github: "read" });
  assert.deepEqual(withApp({ github: "read" }, "github", false), {});
  assert.deepEqual(withApp({ other: "read" }, "github", true), { other: "read", github: "read" });
  const before = { github: "read" };
  withApp(before, "github", false);
  assert.deepEqual(before, { github: "read" });
});

test("saving sends only known read scopes, and nothing for an engine that cannot use apps", () => {
  assert.deepEqual(scopesToSend({ github: "read" }, "claude"), { github: "read" });
  assert.equal(scopesToSend({}, "claude"), null);
  assert.equal(scopesToSend(null, "claude"), null);
  assert.equal(scopesToSend({ github: "read" }, "codex"), null);
  assert.deepEqual(scopesToSend({ github: "read", gmail: "read", slack: "write" }, "claude"), { github: "read" });
  assert.equal(scopesToSend({ github: "write" }, "claude"), null);
  assert.ok(AGENT_APPS.every((app) => app.slug && app.label && app.help));
});
