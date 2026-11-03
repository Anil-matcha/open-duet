import assert from "node:assert/strict";
import { test } from "node:test";
import { agentOneLineDescription, filterAgents, shouldShowAgentSearch, unavailableEnginesInUse } from "../components/chat/agents/agent-list.ts";
import { draftSignature } from "../components/chat/agents/draft-state.ts";

const agent = (overrides = {}) => ({
  id: 1,
  name: "Review helper",
  title: "Reviewer",
  description: "Checks changes before merge",
  instructions: "Read each changed file, then check for regressions.",
  provider: "claude",
  model: "sonnet",
  workspace_path: null,
  approval_mode: "ask",
  archived_at: null,
  ...overrides,
});

test("agent rows use one short description and leave instructions for their own preview", () => {
  assert.equal(agentOneLineDescription(agent()), "Checks changes before merge");
  assert.equal(agentOneLineDescription(agent({ description: "", title: "Reviewer" })), "Reviewer");
  assert.equal(agentOneLineDescription(agent({ description: "", title: "" })), "");
});

test("agent search matches name, description, instructions, engine, model and approval", () => {
  const reviewer = agent();
  const labels = new Map([["claude", "Claude"]]);
  for (const query of ["review helper", "changes before", "regressions", "claude", "sonnet", "ask"]) {
    assert.deepEqual(filterAgents([reviewer], query, labels), [reviewer], query);
  }
  assert.deepEqual(filterAgents([reviewer], "missing", labels), []);
  assert.deepEqual(filterAgents([reviewer], " ", labels), [reviewer]);
});

test("agent search appears only for lists longer than six", () => {
  assert.equal(shouldShowAgentSearch(6), false);
  assert.equal(shouldShowAgentSearch(7), true);
});

test("connection warnings include each unavailable engine used by the visible agents once", () => {
  const engines = [
    { id: "engine-a", label: "Engine A", available: false, signed_in: false, reason: "Not signed in" },
    { id: "engine-b", label: "Engine B", available: false, signed_in: false, reason: "Not signed in" },
    { id: "engine-c", label: "Engine C", available: true, signed_in: true, reason: null },
  ];
  assert.deepEqual(
    unavailableEnginesInUse([{ provider: "engine-a" }, { provider: "engine-a" }, { provider: "engine-c" }], engines),
    [engines[0]],
  );
});

test("draft dirty checks ignore ordering in connected app and account selections", () => {
  const first = { name: "Agent", connector_scopes: { github: "read", gmail: "write" }, connector_account_scopes: { github: ["b", "a"] } };
  const restored = { name: "Agent", connector_scopes: { gmail: "write", github: "read" }, connector_account_scopes: { github: ["a", "b"] } };
  const changed = { ...restored, name: "Changed" };
  assert.equal(draftSignature(first), draftSignature(restored));
  assert.notEqual(draftSignature(first), draftSignature(changed));
});
