# Skills

A skill is a saved set of instructions for one agent, such as "how I want the weekly report written". You choose a skill when you send a message; the agent never uses one on its own.

## What a skill is

- One Markdown file per skill, `skills/<name>/SKILL.md`, in the agent's own folder (next to its notes).
- A short header (`name`, `description`, `enabled`, `source`) and then the instructions.
- Names use lowercase letters, digits and dashes, up to 48 characters. Instructions are at most 32 KB, a description at most 300 characters, and an agent can have 30 skills.
- Text only. Nothing in a skill is run, and files next to `SKILL.md` are never read. A link (symlink) in the skills folder is refused.
- Anything that looks like a secret is replaced when a skill is saved and again when it is read.

## Using a skill

In an agent chat, type `/` at the start of an otherwise empty message to list
that agent's enabled skills. Type more of the name to filter the list. Use
Up/Down to move through the results, then Enter or Tab to attach the highlighted
skill, or click a result. Escape dismisses the list and keeps your draft;
changing the prefix opens suggestions again. Shift+Enter adds a line, and IME
composition does not select a suggestion.

Selection adds a removable skill chip and sends nothing. Write the request and
send it when ready. The skill picker is also available beside the message box.
Chosen skills are omitted from suggestions, and at most three can be attached
to one message. Disabled skills are never offered; switching agents uses that
agent's own list. A complete `/skill-name request` still uses the existing
explicit invocation path, and unknown slash text is sent as ordinary text.

Send a message with up to three skill names (`skills` on `POST /threads/{id}/turns`). The chosen skills' instructions are added before that one message, marked as guidance. They grant no permission and do not change the approval mode: every approval still works as it does without a skill. The next message carries no skill text unless you name one again. The transcript shows which skills a message used (`skill.used`, names only).

A skill that is unknown, turned off, repeated, or chosen in a conversation with no agent refuses the message with `422 skill_unavailable`. Nothing is started.

## Learn from a completed conversation

After a successful person-authored chat turn, **Save as skill** opens an editable draft from that turn's request and result. The server checks that the conversation belongs to the current owner and agent. Failed, cancelled, interrupted, running, routine, webhook and peer turns cannot be used. No model is called and no commands are inferred or replayed.

The draft includes purpose, required inputs, steps, validation, output and approval sections, plus a quoted run reference. Only the request (up to 3,000 UTF-8 bytes) and final result (up to 6,000 UTF-8 bytes) are copied, after secret redaction. Tool logs, attachment contents, files and recalled notes are not copied. Review and replace the workflow sections; a completed run is not proof that a reusable skill works. Remove private or task-specific details from the reference.

Check the review acknowledgement and choose **Save skill**. The save creates a new name only and starts switched off, retaining `learned:<thread id>:<turn id>` provenance. It cannot overwrite a skill created by another tab. **Undo save** removes only that unchanged creation: a later edit, enable/disable, replacement or delete-and-recreate makes the receipt stale. App mutations share a per-agent file lock across backend workers; manual external file edits do not share that lock. The API returns a revision with each skill, so a receipt can be retained independently of the open editor.

To reuse it, explicitly switch it on, then choose it for a message or type `/skill-name`. Test with a second input and inspect the result before routine use. Saving a learned skill neither enables it nor invokes it, schedules a routine, changes an approval, or grants a tool.

## API

All routes are local-access only, like the agents routes. Errors are `{"detail": {"error_code", "message"}}`.

| Route | What it does |
|---|---|
| `GET /agents/{id}/skills` | `name, description, enabled, source, bytes, updated_at` for each skill |
| `GET /agents/{id}/skills/{name}` | the skill with `body`, `redacted` (count) and `warnings` |
| `PUT /agents/{id}/skills/{name}` | create or replace: `{description, body, enabled, source}` |
| `DELETE /agents/{id}/skills/{name}` | remove it |
| `POST /agents/{id}/skills/learn` | `{thread_id, turn_id}` prepares a bounded editable draft without saving |
| `POST /agents/{id}/skills/learn/{name}` | `{thread_id, turn_id, description, body, reviewed: true}` creates the reviewed skill switched off; existing names return `409 skill_exists` |
| `POST /agents/{id}/skills/{name}/undo` | `{revision}` removes an unchanged learned creation; later edits return `409 skill_undo_stale` |
| `POST /agents/{id}/skills/import` | `{markdown}` becomes a preview (`name, description, body, warnings`). Nothing is saved; save the reviewed result with `PUT`, turned off until you have read it |

Warnings flag text that tells the agent to ignore its instructions or skip approvals. They are advice for the reviewer, not a block.

## Agent files

An agent export can include skills (`include_skills=true`; off by default). On import (`include_skills`, on by default) every skill arrives **turned off** with source `imported`, whatever the file says. Skills are bounded (30, 300 KB together) and redacted in both directions. Removing an agent removes its skills.

## What was not run

Covered by tests on SQLite with a scripted engine: the files, limits, redaction, links, preview, the prompt text, refusal, events and the agent-file round trip. Learn-from-run additionally covers source ownership/origin/status, reviewed create-only save, provenance, revision-bound Undo, cross-worker write/Undo serialization, and explicit invocation on a second fixture. The source lookup reads existing thread/turn tables; no skill tables or migration were added. Not run: PostgreSQL source lookup, a real model following a skill, the Windows file-lock branch and file permissions, and phone or desktop screens for the skills UI.
