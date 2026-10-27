import assert from "node:assert/strict";
import test from "node:test";
import { trustedLink } from "./claude-login-link.ts";

test("accepts the current and the older Claude authorize link", () => {
  for (const url of [
    "https://claude.com/cai/oauth/authorize?code=true&state=s",
    "https://claude.ai/oauth/authorize?state=s",
  ]) assert.equal(trustedLink(url), url);
});

test("rejects other hosts, paths, ports, credentials and missing queries", () => {
  for (const url of [
    "https://attacker.example/cai/oauth/authorize?a=b",
    "https://claude.com.attacker.example/oauth/authorize?a=b",
    "https://claude.com/a/b/oauth/authorize?a=b",
    "https://claude.com/cai/oauth/authorizeX?a=b",
    "https://claude.com/cai/oauth/authorize",
    "https://claude.com:444/oauth/authorize?a=b",
    "https://user@claude.com/oauth/authorize?a=b",
    "http://claude.com/oauth/authorize?a=b",
    "not a url", "", undefined,
  ]) assert.equal(trustedLink(url), null, String(url));
});
