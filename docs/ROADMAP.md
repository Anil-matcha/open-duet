# Roadmap

This page tracks gaps in the current product. Planned work is not a promise or
a date. See [FEATURES.md](FEATURES.md) for the shipped surface and its guides.

## Snapshot

Reviewed 2026-10-25 against source `0ffb841`; the latest local desktop tag is
`v0.4.0`, four source commits behind that baseline. Changes after the tag are
source-only until a later installer is built and checked. The
[capability matrix](CAPABILITIES.md) records current engine support and the
remaining live-provider and artifact qualification gates.

Current source already has named agents, an offline role gallery, explicitly
invoked agent skills, memory and recall, search and attachments, routines,
delegation and rooms, approval-gated Docker computers with desktop takeover,
structured Chromium tools, a personal self-hosted mode, and desktop setup and
updates. The product gaps below build on those features.

## Highest priority

### P0 — Close the source-to-installer verification gap

Check the tagged installer against the published [capability matrix](CAPABILITIES.md).
Verify setup, updates, teams/rooms and computer flows on the actual packaged
builds for each target platform. Keep the unsigned/experimental label until
the release path is dependable.

### P0 — Qualify Linux server isolation

Require filesystem/process isolation and enforceable network isolation, with
real-host checks, before expanding unattended server integrations. Environment
filtering alone does not isolate a turn from the server's files or network.

### P1 — Make memory writes truthful and durable on every supported engine

Standalone literal `Remember that <one fact>` requests now write a private,
journaled note before the engine answers, including Codex with no helper.
Provenance, simple first-person corrections, secret refusal and truthful
write/Undo receipts have automated coverage. Complex conversational corrections
and live-provider/packaged qualification remain open. See [memory](MEMORY.md).

### P1 — Qualify guided agent setup by chatting

The discoverable create-by-chat entry, clarification, exact engine/model
discovery, applied details and safe Undo are implemented for Claude and Codex.
Codex has a recorded live create/correct/Undo run. Qualify Claude, PostgreSQL
and packaged artifacts; separately verify long Codex delegation and resume.
See [chat management](CHAT_MANAGEMENT.md).

### P1 — Connect calendar, email and a useful daily view

Add read-only Google Calendar context first, including meeting preparation and
event freshness. Add Gmail read-only triage, then a separate draft-only action
that can create a reply only in a thread already reviewed. Sending mail should
remain a separately granted and explicitly approved action. Extend the
existing **Needs you** card into a quiet, source-linked Today view for meetings,
important mail, routine outcomes, approvals and connection problems. Do not
report an unavailable provider as an empty inbox or calendar.

### P1 — Let people manage routines from chat

Routines already have a UI, schedule preview, run history, webhooks, approvals,
retry controls and chat management tools. Keep newly proposed routines disabled
until review. Durable webhook delivery receipts now deduplicate retries when
the sender supplies an `Idempotency-Key`; qualify PostgreSQL concurrency, then
add applied-result cards and safe Undo. Connected-app event triggers need
separate grants, provenance and bounded retries.

### P1 — Finish room management and routing

Rooms already support fixed-member, everyone and mention-based replies, shared
instructions, separate member conversations, approval display, hold/resume and
exports. Add safe roster editing while preserving history and queued work.
Then consider opt-in model-assisted selection for untagged messages, with
explicit-mention bypass, confidence thresholds, deterministic fallback and
metadata-only routing logs. Keep tool approval rules unchanged.

### P1 — Expand connected-app access after core trust work

GitHub is available through your own Composio key: connect it in Settings,
then allow it per Claude agent as Read only or Read and change, where every
change asks on a card (see [connected apps](CONNECTED_APPS.md)). Gmail and
Calendar can be connected but have no agent tools. Next: other apps such as
Gmail, Calendar, Slack and Notion, each with a fixed, reviewed tool list
checked against the live app; Codex support; custom MCP authentication; and
app-event triggers, which also need a way to receive events. Keep
idempotency, revocation (check it at the provider), clear data provenance and
bounded responses as the bar for every new app.

### P1 — Verify memory, teams and computers across engines

Keep the [compatibility matrix](CAPABILITIES.md) current for Claude, Codex, ACP
and API engines. Team tools and Docker browser tools support Claude and Codex;
computer access varies by engine. Test approvals, failures, hostile tool
results and longer-running work for each supported path before broadening the
claims.

## Next product additions

### P2 — Learn and share reviewed skills

Open Duet already supports per-agent Markdown skills, import preview, secret
redaction, explicit invocation and disabled-by-default imports. Add a flow to
draft a skill from a successful run, review/edit it, and verify it on a second
fixture before saving. Later allow safe team sharing with text-only export,
secret scanning and imported skills disabled until review.

### P2 — Extend templates into safe import and team sharing

The bundled role gallery and single-agent import/export are shipped. Add local
team-package import, GitHub and external-bot import, bounded project-folder
suggestions, reusable presets and whole-team export. Preview fields, omit
secrets, credentials, permissions, history and local paths, and import
autonomous features disabled. A managed organization catalog is a separate
future decision.

### P2 — Improve file and computer reach

Add bounded PDF and Office document extraction with visible failures. Decide
whether remote VPS computers are needed; if so, design workspace placement,
SSH trust, viewer transport, lifecycle, egress and cost before building them.
For local Docker computers, evaluate a real egress policy and clearer handling
when another conversation owns the screen. Keep isolated Docker as the default.

### P2 — Add voice and richer media

Stage spoken replies before live calls. Add optional text-to-speech settings,
macOS dictation that inserts editable text without sending, and a half-duplex
call view with captions and explicit mute/hang-up controls. Keep screenshots
from intentional actions as bounded transcript attachments; do not retain
polled preview frames.

## Deliberate scope

- Keep personal self-hosting single-owner. Multi-tenant hosting, organization
  accounts and billing are not part of the current desktop/server path.
- Build the core workspace and trust controls before a very broad app catalog.
- Treat mascots and other cosmetic parity as lower priority than integrations,
  memory correctness and release confidence.
- Do not rebuild the existing search, role gallery, routines, team delegation,
  rooms, desktop preview, takeover or structured browser tools.

### Linux turn sandbox preview

Local CLI turns can opt into a Linux bubblewrap filesystem/PID box with explicit
mounts and a launch self-check (`TURN_SANDBOX_ENABLED`; see
[SELF-HOSTING.md](SELF-HOSTING.md#optional-linux-turn-sandbox-preview)). It fails
closed when unavailable and keeps status probes outside the box. This adds the
stage C implementation; real-host lifecycle qualification, network isolation
(stage D), credential brokering and syscall filtering remain open.
