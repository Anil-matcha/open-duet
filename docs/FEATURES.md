# Features

Open Duet is a workspace for named AI agents, durable conversations, teams,
and recurring work. This page describes the repository's current source;
features added after a desktop release tag may not be in that installer. See
the [README](../README.md) for install options and the [roadmap](ROADMAP.md)
for remaining work and the [capability matrix](CAPABILITIES.md) for engine,
platform and release qualification limits.

## Agent workspace

- **Agents and starting roles.** Create named agents with their own
  instructions, engine/model, workspace, approval mode, notes and skills. Use
  the bundled, searchable role gallery to start an agent; the person reviews
  and saves the configuration. Agent files can be exported and imported with
  safer defaults. See [templates](TEMPLATES.md), [skills](SKILLS.md), and
  [setup](SETUP.md#the-chat-page).
- **Chat and files.** Conversations persist across reloads, stream answers and
  tool activity, and support stop, search, text/image attachments, workspace
  file browsing and downloads, and reported token/cost visibility. See
  [everyday features](EVERYDAY.md).
- **Memory.** Agents can use private notes, topic notes, cross-chat recall,
  past-conversation search, memory proposals and upkeep, compaction, and a
  journal with undo. Availability of model-powered upkeep depends on the
  selected engine or a configured helper. See [memory](MEMORY.md).
- **Teams and rooms.** A Claude or Codex lead can delegate to specialists and manage
  shared rooms with member mentions, shared instructions, responder settings,
  queued replies, approvals and run status. Team tools are gated and require
  Claude or Codex. Room members are selected at creation and cannot yet be
  changed afterward. See [teams](TEAMS.md).
- **Skills.** Save or import reviewed Markdown instructions for an agent and
  choose them explicitly for a message. Skills do not execute scripts or grant
  permissions. See [skills](SKILLS.md).

## Engines, approvals and computers

- **Engines.** The source includes Claude, Codex, generic ACP and
  OpenAI-compatible/OpenRouter paths, plus opt-in Gemini and Cursor ACP presets
  and experimental OpenCode, plus managed Google Antigravity account setup.
  Engine capabilities differ: for example,
  attachments, teams, memory tools and computers are not available on every
  engine. See [engine setup and capabilities](ENGINES.md).
- **Approvals.** Ask, Accept edits and Plan modes, saved command rules, a safety
  floor, a redacted decision log and a read-only health scan. Computer actions
  use the same approval boundary. See [setup and approvals](SETUP.md#approval-modes-saved-rules-and-the-decision-log).
- **Agent computers.** An agent can run in its own Docker shell or Linux
  desktop with bounded tools, resource limits, a workspace mount, live viewing
  and take-control. Structured Chromium tools are opt-in for Claude and Codex
  Docker agents; real Codex browser/provider qualification remains open.
  The desktop app also has a separate opt-in native macOS preview. These
  features remain experimental; remote SSH computers and enforceable egress
  allowlists are not implemented. See [computers](COMPUTERS.md),
  [browser tools](BROWSER.md) and [native desktop](NATIVE-DESKTOP.md).
- **Connected apps.** Browse Composio's apps on the Apps page and connect them
  through your own Composio key, then allow them per Claude or Codex agent.
  GitHub, Gmail and Google Calendar have their own bounded tools; any other app
  is used through a general search-and-run pair where you approve every call.
  Changes ask on a card and are never retried. See
  [connected apps](CONNECTED_APPS.md).

## Routines, access and distribution

- **Routines.** Run an agent on a schedule, by webhook or on demand. Runs have
  durable history, missed/interrupted states, approval handling, notifications
  and configurable retry of failed runs. A routine never approves actions by
  itself. See [routines](ROUTINES.md).
- **Owner access and self-hosting.** Use a local desktop, or run a personal
  server with owner sign-in, paired-device scopes, HTTPS proxy guidance,
  backups and updates. This is a single-owner product; multi-user organization
  hosting is not implemented. See [authentication](AUTH.md) and
  [self-hosting](SELF-HOSTING.md).
- **Phone app.** An early, source-only app pairs with your server as a chat-only
  device to list and start conversations, follow answers live, stop one, and
  allow or deny tool calls. No push notifications, no store release, and not yet
  tried on iOS or a physical phone. See [the phone app guide](MOBILE.md).
- **Desktop app.** The app has first-run setup, engine settings, a doctor
  command, SQLite storage and unsigned Windows/macOS installers. The `v0.3.0`
  prerelease has a Windows x64 installer; the newest macOS arm64 DMG is
  `v0.2.0`. The `v0.3.0` Windows app includes an assisted, checksum-verified
  updater; it does not install an update automatically. The release-to-release
  update path has not been verified end to end.
- **Optional legacy path.** The original Boat sandbox tasks and Telegram bot
  remain separate from the local agent workspace. Neither is needed for local
  chat or routines.
- **Approval modes, saved rules and the decision log (backend):** `ask`, `accept_edits` and `plan` map onto the Claude CLI's permission modes; "always allow" saves an exact Bash command for a workspace folder, and prefix rules can be added through the API for programs that cannot run code through an argument (`ls`, `grep`, `jq`; `sed`, `awk`, `git`, `make` and the like are exact-only); a safety floor (recursive deletes of `/`, home or system folders, disk formatting, force pushes, fork bombs, and commands that cannot be read) is never auto-allowed; every decision is appended, redacted, to a monthly file that `GET /api/v1/decisions` reads and `GET /api/v1/decisions/export.csv` exports. Removing a saved rule is logged as `undone`. A read-only health scan (`GET /api/v1/sentinel/scan`, or `python -m app.services.sentinel`) reports retry loops, repeated denials, tool errors and failed answers without ever storing tool output. See [SETUP.md](SETUP.md#approval-modes-saved-rules-and-the-decision-log).
- **Approvals in the Chat page:** "Always allow this command" on a shell command's card (with Undo), a note when a saved rule allowed a call, the approval mode in the header, and an Approvals panel (also in desktop Settings) to manage saved rules per folder, page and filter the decision log and export it as CSV, and run the health scan. See [SETUP.md](SETUP.md#the-chat-page).

- **Engines and model selection:** Claude, Codex (`codex app-server`), a generic ACP command and OpenAI-compatible chat endpoints (with an OpenRouter preset that needs only an API key) share durable threads. Pick an engine and model for an agent or a new chat; change an existing conversation’s model while idle. Existing conversations keep their engine when an agent changes engine. **Settings → Engines** works in the web and desktop UI, reports readiness and capabilities, and saves an ACP command or encrypted endpoint configuration. A missing Claude installation does not block another ready engine. OpenAI-compatible endpoints are chat only; agent computers require Claude. See [ENGINES.md](ENGINES.md).

- **Desktop settings:** configure the Claude executable and default workspace root with native Browse dialogs, local tools, answer/approval timeouts and output limit. Per-field saves are versioned in the database, sensitive changes are audited, and the page shows sources, effective values and validation errors. New turns use saved configuration; running turns and existing approval deadlines stay unchanged. Conversations keep their original workspace across changes and restarts. Storage information is read-only; the first-run setup can be replayed here. See [SETUP.md](SETUP.md#desktop-app-from-a-source-checkout-experimental).

- **Named agents (backend):** save instructions, engine, model, workspace and approval mode under a name and start conversations from it (`agent_id` on `POST /api/v1/threads`). Model edits apply from the next message when the conversation follows its agent and still uses that engine; approval-mode edits apply from the next message; instructions and notes are read when a conversation starts (the Claude CLI keeps a resumed session's system prompt); its workspace stays as it was when it began. Pin, archive, duplicate and delete are in `/api/v1/agents`. See [SETUP.md](SETUP.md).
- **Agent notes:** each agent keeps `MEMORY.md` in its own folder; the first 200 lines (24 KB) load into every conversation with it, with anything that looks like a secret redacted. Read and edit them with `GET`/`PUT /api/v1/agents/{id}/memory` (a hash check stops a save from overwriting the agent's own edit) or in the Agents panel; switch them off per agent; give a new agent starter notes. See [SETUP.md](SETUP.md#agent-notes-and-agent-files).
- **Topic notes, recall and compaction:** agents keep `memory/<topic>.md` notes beside `MEMORY.md` (indexed in the prompt, same redaction, atomic writes, caps and hash checks); before each turn matching note and past-conversation passages are added to the message (not the system prompt) and shown as a **Recalled** chip, with a per-agent switch; long conversations on OpenAI-compatible and ACP engines are folded into a stored excerpt summary at a per-engine token budget, marked **Earlier messages summarized**; a journal with undo and a proposed-notes queue you accept or reject. See [MEMORY.md](MEMORY.md).
- **Agent files:** export an agent as one `.agent.json` (name, title, description, instructions and optionally notes; never model, folder, approval mode or conversations) and import it elsewhere, where it starts on Ask first. See [SETUP.md](SETUP.md#agent-notes-and-agent-files).

- **Agent computers (experimental):** give an agent its own isolated Docker container and its turns run their commands and file edits there, never on this machine: non-root, no capabilities, CPU/memory/process limits, network off by default, only its workspace folder mounted. Every call still goes through the approval gate, and a one-use permit per approved call means nothing unapproved can run. Start, stop, recreate, limits, idle stop, removal and Docker health from the Agents panel or `/api/v1/computers`; a Computer chip in the chat header. See [COMPUTERS.md](COMPUTERS.md).

- **Desktop first-run setup:** detects engine readiness and explains CLI sign-in, selects an engine/model and workspace root, explains approval modes and optionally creates a starter agent. Completion is saved in the app database; skip and replay are available. CLI source prerequisite diagnostics are available with `npm run doctor` in `desktop/`. Source desktop engine/setup flows have been exercised on macOS; signed installers, updates and Linux first-run verification remain open.

Limitations: see "Known limitations" in the [README](../README.md).
