# Capability and release qualification

Reviewed 2026-10-25 against feature source `6b7fba1` / integrated checkpoint
`cbc62b7`; baseline `15caa55`. See the [automated verification record](verification/roadmap-next-20261025.md).
This table describes source
support. A successful scripted test does not establish real-provider behavior
or compatibility with an installer. New commits require a new qualification
record before release.

## Engines

| Engine | Prerequisite and model choice | Attachments | Approvals | Teams and chat setup | Computers / browser | Continuation |
|---|---|---|---|---|---|---|
| Claude | Installed, signed-in `claude`; catalog suggestions and custom IDs | Text and images | Per-tool gate; Ask, Accept edits, Plan | Yes | Docker and opt-in native macOS; Docker Chromium | Native resume |
| Codex | Installed, signed-in `codex`; catalog suggestions and custom IDs | Text | App-server approval requests and checked sandbox policy | Yes | Docker, including opt-in Chromium; native macOS unavailable | Native thread resume |
| Gemini CLI | Installed and authenticated CLI or saved key; selected model confirmed by ACP | Text | ACP permission requests; upstream configuration also matters | Unavailable | Unavailable | Native if advertised; otherwise stored transcript |
| Cursor | Installed and authenticated CLI or saved key; live model catalog | Text | ACP permission requests; review upstream allow rules | Unavailable | Unavailable | Native if advertised; otherwise stored transcript |
| Antigravity | Managed runtime and isolated personal Google sign-in; account model catalog | Text | ACP permission requests; default mode confirmed before prompt | Unavailable | Unavailable | Native resume within the same account profile |
| OpenCode (opt-in experimental) | Installed and authenticated CLI; offered model confirmed | Text | Permission override unqualified against hostile real configuration | Unavailable | Unavailable | Native if advertised; otherwise stored transcript |
| Generic ACP | Configured authenticated ACP command; agent default model | Text | ACP permission requests; upstream configuration also matters | Unavailable | Unavailable | Native if advertised; otherwise stored transcript |
| OpenAI-compatible / OpenRouter | Configured endpoint and optional key / OpenRouter key; endpoint model IDs | Text | Chat only, no tool execution | Unavailable | Unavailable | Stored transcript |

Text attachments are bounded text added to the prompt. Images are accepted only
by engines advertising image support. Cross-chat history search is available
through the memory bridge on Claude, Codex and ACP, subject to agent settings;
it does not itself persist notes. See [memory](MEMORY.md).

Connected apps (GitHub, Gmail and Google Calendar through your own Composio
key) can be allowed per agent on Claude and Codex, as Read only or Read and
change where available; every change asks on a card. Codex source support is
implemented, but its live Composio flow has not yet been qualified. See
[connected apps](CONNECTED_APPS.md).

## Evidence levels

| Feature | Source / automated coverage | Live-provider evidence already recorded | Packaged release gate |
|---|---|---|---|
| Guided agent create, correction and Undo | Team service, router, Codex protocol and frontend tests | Codex CLI 0.164.0 create → same-agent correction → Undo, recorded 2026-10-24 in [chat management](CHAT_MANAGEMENT.md) | Open on macOS and Windows; Claude live flow also open |
| Delegation and rooms | Scripted engine tests, policy/origin checks and lifecycle tests | Codex long delegation and restart/resume remain open; setup evidence does not qualify delegation | Open |
| Planner claim/run lifecycle | Planner service and API tests | Real selected-engine task execution remains a separate gate | Open |
| Docker computer tools | Scripted protocol/isolation tests | Codex CLI 0.164.0 Docker command confinement recorded in [engines](ENGINES.md#codex); focused macOS checks recorded in [computers](COMPUTERS.md) | Open on each shipped platform |
| Structured Chromium | Boundary tests and opt-in real Chromium fixture suite | Codex provider/browser flow remains open | Open |
| Antigravity | Synthetic install, OAuth, model, approval and resume tests; official macOS ARM64 runtime startup | OAuth URL startup only; complete account sign-in and prompt/approval/resume remain open | Open; Windows unsupported |
| Install/update/recovery | Desktop launcher, updater and backend startup tests | Installer download/install, upgrade preservation and recovery require actual artifacts | Open |
| Personal server | Server smoke, pairing and lease tests | Real Linux deployment, sign-in, update and backup/restore remain open | Open |
| Explicit private notes | Standalone literal remember requests, no-helper Codex fixture, provenance, simple correction, redaction and Undo tests | Real-provider response behavior remains open | Open |
| Webhook deduplication | Durable delivery receipts, concurrent SQLite admission, restart and authorization tests; PostgreSQL schema/migration checks | Live PostgreSQL concurrency remains open | Open |
| Linux turn sandbox preview | Opt-in filesystem/PID box plus separately enabled private network namespace/public HTTP(S) gate; policy and transport tests, real namespace checks skip on macOS | Real Linux enforcement and engine lifecycle remain open | Open |
| Routine change receipts and Undo | Dedicated source result card; revision/run/scope-bound Undo, paused restoration and concurrent SQLite checks | Real providers and PostgreSQL multi-backend Undo remain open | Open |
| Connected apps (GitHub, Gmail and Calendar through Composio) | Client, routes, approval policy and bridge; Claude adapter coverage with a fake Composio; Codex per-turn MCP mounting and approval routing | Windows, desktop and web, real Claude CLI, own Composio project and a private repository, 2026-10-26, by hand (see [connected apps](CONNECTED_APPS.md#what-has-been-checked)); Codex/Gmail live calls not checked | Open; packaged shim, Linux sandbox and live Codex flow not run |
| Local Today brief | Durable approvals/questions, routine outcomes, engine failures and due tasks; source links, timezone and deduplication checks | Live-source and packaged UI qualification remain open; Calendar/Gmail unavailable | Open |

Historical evidence belongs to the source and environment recorded in its
linked guide. It is not automatically refreshed by running a newer unit suite.
Unlisted live-provider or packaged combinations are unqualified.

## Platforms and release procedure

macOS ARM64 and Windows x64 are desktop package targets. Native macOS control
requires a separately staged reviewed bundle and is omitted from the unsigned
installer. Antigravity and preset CLIs are not supported on Windows. Linux is
the personal-server target; desktop unit tests on macOS do not qualify it.

For each candidate, record the source SHA, release tag, artifact filename and
SHA-256, OS/architecture, engine/CLI version, database and date. For each row
above, record **passed**, **failed**, **not run**, or **unsupported**, and link
the exact command/output or redacted manual evidence. Keep live-provider and
packaged results in separate columns.

1. Run backend tests on SQLite and PostgreSQL, frontend checks, desktop tests,
   backend/server smoke and the isolated Chromium suite. Preserve failures and
   skip reasons. A skipped real-service test is not a pass for that service.
2. Build the candidate from the recorded source. On each target OS, install
   into a fresh profile, sign in, and exercise chat, approvals, Stop and resume.
   Check the feature rows above with the actual packaged backend and UI.
3. Upgrade a populated earlier profile. Verify agents, history, planner tasks,
   routines, encrypted configuration and sign-in remain usable. Check rejected
   downloads, unavailable engines and interrupted-start recovery.
4. For a server release, deploy on real Linux and verify owner sign-in,
   pairing/revocation, engine sign-in, update, backup and restore. Qualify
   filesystem/process and network isolation separately before expanding
   unattended integrations.
5. Publish the completed matrix beside the artifact. Leave every unexecuted
   gate open; a source implementation or a green CI run cannot close it.
