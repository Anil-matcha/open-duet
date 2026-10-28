import assert from "node:assert/strict";
import test from "node:test";
// Load the pure helper without importing the browser API transport.
import fs from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = (await fs.readFile(new URL("./onboarding.ts", import.meta.url), "utf8"))
  .replace('import { request } from "./api";', "const request = () => { throw new Error('No network in this test'); };");
const { onboardingChatHref, STARTER_ROLES } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

test("handoff carries selection without putting a private request in a URL", () => {
  const draft = { provider: "codex", model: "model/with spaces", first_request: "Private business question" };
  const plain = new URL(onboardingChatHref({ agent_id: null, draft }), "http://localhost");
  assert.equal(plain.searchParams.get("engine"), "codex");
  assert.equal(plain.searchParams.get("model"), "model/with spaces");
  assert.equal(plain.searchParams.get("onboarding"), "1");
  assert.ok(!plain.href.includes("Private"));
  const agent = new URL(onboardingChatHref({ agent_id: 17, draft }), "http://localhost");
  assert.equal(agent.searchParams.get("agent"), "17");
  assert.equal(agent.searchParams.has("engine"), false);
});

test("starter roles offer editable purpose and a first request", () => {
  assert.equal(new Set(STARTER_ROLES.map(role => role.name)).size, STARTER_ROLES.length);
  assert.ok(STARTER_ROLES.every(role => role.name && role.purpose && role.first_request));
});
