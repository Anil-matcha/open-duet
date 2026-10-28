# Self-hosting verification — S′ walkthrough

**Claim set under test:** `docs/SELF-HOSTING.md` ("agents and routines keep working
with your laptop closed"). **Host:** a private Linux host (non-root, no systemd,
private IP). The platform name is kept in the internal record only.

**Run:** 2026-10-26, direct-install route (Route 2). Engine: `openai_compat` via
`api.river.ai/v1` (`deepseek-ai/DeepSeek-V4.1-Flash`) for the conversation row; the
ACP engine (OpenCode CLI 1.18.33) for the tool row. All state under the scratch root
`/tmp/sprime-walkthrough`; every transcript captured through the AC 3 redaction
filter.

**Stop rule (AC 8):** started `2026-10-26T17:58:55Z`, stopped `2026-10-26T20:20:24Z`
— **2h 21m of the 6-hour box**, all runnable criteria met; the remainder are
not-run for the platform reasons below.

---

## Row table

Severity vocabulary follows the crash harness: `available` / `degraded` /
`not-available`.

| # | Upstream claim | Row class | Severity | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Direct install runs, serves, signs in | **real** | available | `01-build-ui`, `02-uv-sync`, `03-migrate`, `04-set-passphrase`, `05-doctor` (`0 problem(s)`), server up, `/api/v1/health` → `{"status":"ok"}`; `06-signin` HTTP 200 + session cookie |
| 2 | Conversation with a real engine works | **real** | available | `08-conversation`: turn `completed`, assistant replied `OK from river`; server log shows live `POST api.river.ai/v1/chat/completions → 200` |
| 3 | An agent can use its tools in a turn | **real** | available | `10-acp-tool`: ACP/OpenCode ran the Bash tool (`tool.started`→`tool.completed`) and returned `approval-needed-test` |
| 4 | SIGTERM + restart keeps state durable | **real** | available | 5 threads before `kill -TERM`; process exited in 2s; after restart 5 threads + events intact — durability **PASS** |
| 5 | Gateway address means the host (proxy) | **simulated-labeled** | degraded | `12-gateway` loopback hop passed with the fidelity statement below; the app's trust path is loopback-by-default (`forwarded_allow_ips` from `TRUSTED_PROXIES`) |
| 6 | Approvals stop and resume a turn | **not-runnable-here** | not-available | no engine on this host emits a permission request: `openai_compat` is chat-only by design (`tools=False`); OpenCode (ACP) auto-approves this command and never sends `session/request_permission`, even under an agent pinned to `approval_mode: "ask"`; Claude Code is installed but every turn fails behind an envoy gateway (see D-3); Codex is not signed in |
| 7 | Cloud-computer drive inside a turn | **not-runnable-here** | not-available | no engine on this host advertises `capabilities.computers` (OpenCode: `computers=false`; OpenAI-compat: `computers=false`); the computer path needs Claude/Codex |
| 8 | HTTPS via Caddy/nginx | **not-runnable-here** | not-available | no public domain/ports on this platform |
| 9 | Runs as a systemd service | **not-runnable-here** | not-available | PID 1 is `init`, no root. The unit's ExecStart commands were exercised manually (`python -m app.server` start/stop); **"ExecStart verified, systemd itself not exercised."** |
| 10 | Rootless Docker/Podman/Traefik | **not-runnable-here** | not-available | no root on this platform |
| 11 | Pairing from a second device | **not-runnable-here** | not-available | no route from another device to this private host; sign-in verified on-server (`06-signin`) |

**Honest note on rows 1–4:** install, conversation, tools and durability are `real`
and green. Rows 6–7 are the two the product's "leave it running" promise most
depends on for *approvals and computers*, and they are the two this host cannot
exercise — the honest table records that rather than implying a green.

---

## Fidelity statement (AC 1) — verbatim

> `simulated-labeled (loopback hop):` emulates forwarded-header field
> (`X-Forwarded-For`) carry from client to server, and host substitution (the
> proxy's `Host` reaching the app); does **NOT** emulate multi-hop
> `X-Forwarded-For` chains, TLS termination, connection-upgrade/websocket
> passthrough, or real proxy trust semantics (a third party cannot forge the
> chain). The hop alone cannot prove the row has teeth (it carries the header
> regardless of trust) — the teeth were measured against the server's own
> `TRUSTED_PROXIES` refusal path (below).

**AC 4 control — teeth on the server's real path (live).** Start-up refuses a
wildcard/unbounded/host-name proxy list exactly as the docs claim:

```
TRUSTED_PROXIES=*            -> REFUSED: cannot be * ...
TRUSTED_PROXIES=0.0.0.0/0    -> REFUSED: covers every address ...
TRUSTED_PROXIES=dots.example.com -> REFUSED: not an IP address or network ...
TRUSTED_PROXIES=172.31.250.1 -> accepted: ('127.0.0.1','::1','172.31.250.1')
```

---

## Defects (AC 7 / AC 10)

Each names its triage bucket (upstream PR / fork-only / platform config).

| # | Defect | Reproduction | Bucket | Resolution |
| --- | --- | --- | --- | --- |
| D-1 | Fresh `npm ci` can exit 0 leaving an incomplete `next` install (`node_modules/next/dist/server/require-hook.js` missing), so `node scripts/build-ui.js` fails with `Cannot find module '../server/require-hook'`. | clone, `npm ci` (exit 0), `node scripts/build-ui.js` → MODULE_NOT_FOUND; a second `npm ci` fixes it. | **platform config** (npm cache/registry race on this host; not reproducible from a clean upstream checkout in CI) | ran `npm ci` again; build green. Recorded for the install notes. |
| D-2 | The AC 3 redaction filter over-redacted absolute paths (the `>=40`-char opaque-token heuristic ate `/tmp/.../frontend/out`). | `redact("/tmp/sprime-walkthrough/clone/frontend/out")` → `/<redacted:opaque-token>`. | **fork-only** (our scaffold's filter) | tightened the catch-all (no path separators; requires mixed classes); added a path-preservation regression test; 7/7 green. |
| D-3 | Claude Code engine fails on this host: every turn ends `API Error: API returned an empty or malformed response (HTTP 200)` with `x-envoy-*` headers. | create a `claude` thread and send any turn. | **platform config** (an envoy gateway intercepts outbound Claude API traffic on this host) | none — recorded as the reason rows 6/7 (which need Claude/Codex) are not runnable here. |
| D-4 | The direct-install route's SELF-HOSTING.md prose does not mention `SQLITE_PATH` / `LOCAL_WORKSPACE_ROOT`, so a reader following only the guide lets the data dir and workspace default to `~/.open-dots` (home). | install per §Route 2, `migrate` → `~/.open-dots/open-dots.db`; `doctor` → workspace under `~/.open-dots/local/workspace`. | **fork-only / docs nit** (both settings ARE documented in `deploy/open-dots.env.example:25,36` with the `~/.open-dots` default spelled out; the guide's prose just doesn't cross-reference) | for this run: set `SQLITE_PATH` + `LOCAL_WORKSPACE_ROOT` into the scratch root and removed the stray `~/.open-dots`. Not raised upstream — the env example already covers it. |

---

## Stop rule (AC 8)

> Walkthrough time-boxed to **6 hours on this host, or all criteria met —
> whichever first**. Stopped at `2026-10-26T20:20:24Z` (2h 21m elapsed);
> **5/11 rows `real` green**, 1 `simulated-labeled`, 5 `not-runnable-here` with the
> reasons above. No overtime; nothing silently expanded.

## Host state (AC 9)

- **Install root:** `/tmp/sprime-walkthrough` (scratch dir; ~953 MB). The operator's
  real drives were not written except the stray `~/.open-dots` noted under D-4,
  which was removed.
- **Clone:** kept at `/tmp/sprime-walkthrough/clone` for now; **to be removed** when
  the run is archived (no reason to retain a 950 MB build on a shared host).
- **Session DBs:** `/tmp/sprime-walkthrough/open-dots/state.db` (SQLite, mode 600
  via the env-implied default). Neither clone nor DB was committed anywhere.
- **Env file:** `/tmp/sprime-walkthrough/open-dots.env`, **mode 600**; keys also in
  `/tmp/sprime-walkthrough/.env.keys` (mode 600, scratch only, not committed).
- **Key hygiene:** the river key touched this shared/ephemeral host.
  **Recommendation: rotate the river key with the provider now that the artifacts
  are captured.** The app stores it encrypted (Fernet, `TOKEN_ENCRYPTION_KEYS`) in
  the scratch DB; nothing else persisted it.

## Secret discipline (AC 3)

- Filter: `scripts/self-host/redact.py` — knows the zen/opencode prefix, the river
  `rv_` prefix, the app passphrase (registered via `SPRIME_PASSPHRASE`), and
  JWT-shaped `eyJ…` session tokens.
- Transcripts captured **through** the filter; no `set -x` anywhere.
- The known leak venue (sign-in) was captured through the filter: `06-signin.txt`
  shows `set-cookie: od_session=<redacted:opaque-token>` and
  `csrf_token=<redacted:opaque-token>`; **0** raw `eyJ` occurrences; the literal
  passphrase is absent.
- Post-run grep over **every** artifact: `verify_no_secrets.py` → **0 findings**.

## Issue #206 follow-through

The published Not-run matrix gains: rows 1–4 verified green on a real Linux host
(direct install, river-engine conversation, tool use, SIGTERM durability); row 5
recorded `simulated-labeled` with the fidelity clause; rows 6–7 shown to be
engine-gated (need Claude/Codex) rather than doc gaps; rows 8–10 are platform
limits as the docs already state. No upstream-code defect was found; the only
follow-up is a docs cross-reference (the guide's Route 2 prose could point at the
`SQLITE_PATH`/`LOCAL_WORKSPACE_ROOT` settings already listed in
`deploy/open-dots.env.example`). Draft text: *"Verified the direct-install
background path on a private Linux host: install, river-engine conversation, tool
use and SIGTERM durability are green; approvals/computer rows need a tool-capable
engine (chat-only endpoints, and OpenCode auto-approves without a permission
request), and Route 2's prose could cross-reference `SQLITE_PATH` /
`LOCAL_WORKSPACE_ROOT` so installs don't default under `~/.open-dots`."*
