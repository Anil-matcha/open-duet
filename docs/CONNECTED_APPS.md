# Connected apps

Connect an app on the Apps page (sidebar → Apps), then choose which Claude or Codex agents may use
it. Apps are reached through [Composio](https://composio.dev) with **your own
Composio project key**; there is no shared key and nothing is sent to a
service run by this project.

Any app Composio lists can be connected, and then allowed for Claude and Codex
agents. Two kinds of app exist:

- **GitHub, Gmail and Google Calendar have their own tools.** Each tool is
  written and checked here: its arguments are fixed, its answer is cut to a few
  fields, and Gmail can only save drafts or send one plain-text email to one recipient. For these apps, those tools are all an
  agent gets.
- **Every other app is used through two general tools**: one finds the app's
  actions, the other runs one. No action of these apps is treated as a read, so
  **you approve every call** (see "Other apps" below).

The app mounts a turn-scoped, permission-filtered MCP server and sends Codex MCP
approval requests through the same approval gate used for Claude. Other engines
cannot use connected apps yet.

## Set it up

1. **Get a key.** Create a Composio account and a project, then copy the
   project key (it starts with `ak_`).
2. **Save it.** Apps → paste the key → Save. Without a key the Apps page shows
   only a short starter list of common apps; with one it lists everything Composio
   offers, with search, categories and "Show more apps". The key is
   checked with Composio first, stored encrypted on this computer, and never
   shown again. To change it, use Replace key.
3. **Connect the app.** Choose Connect next to any app. Some apps have no sign-in
   Composio supplies (they need an auth config of your own in Composio, which this
   app does not set up); their card says so and has no Connect button. Your browser opens a Composio page; sign in to that app and
   approve. This page notices when you are done. You may give the account a
   name; with more than one account for an app (up to five) the agent must say
   which one to use.
4. **Allow an agent.** Open an existing Claude or Codex agent, find Connected
   apps, choose **Off** or **Read only** for each app; every app also has
   **Read and change**. Any app you connected appears there. For apps without
   their own tools, "Look up only" lets the agent see what actions exist and
   "Look up and run" lets it ask to run them. Save, start a new conversation with that agent,
   and ask naturally, for example, “Find the latest unread message from Alex
   and summarize it,” “What is on my calendar tomorrow?” or “Draft a reply to
   that email.” New agents and copies start with all apps Off. If the agent was
   already chatting, start a new conversation so it receives the updated tool
   list.

Only the owner can do this. A paired chat device cannot see or change the key
or the connections.

## What an agent can do

| Level | It can |
|---|---|
| Read only · GitHub | Read your profile, repositories, issues and pull requests, issue comments, pull request files, commits, branches and file contents (or list a folder), and search issues and pull requests. |
| Read only · Gmail | Search up to 30 messages per page, read one message or thread, and see the connected account profile. Message bodies and previews are cut to a small field allowlist. |
| Read only · Google Calendar | List calendars, search events by words (a window of up to a year), and read event summaries in a timezone-qualified date window of up to 31 days. |
| Read and change · GitHub | Everything above, and create an issue, comment on an issue or pull request, and close or reopen an issue. |
| Read and change · Gmail | Read access plus creating a plain-text draft reply or sending a plain-text email to one recipient. Forward, archive and delete tools are unavailable. |
| Read and change · Google Calendar | Read access plus creating one timed event (at most 7 days long) on a calendar. It has no guests and no video meeting, so nothing is emailed. |

For an interactive Gmail draft, the recipient and subject are supplied by the
agent and shown in the approval card. The current chat tool does not verify
that recipient against the thread's sender; check it before approving.

Not available at any level: forwarding email; adding Gmail cc/bcc or
extra recipients; archive, label or delete actions; inviting guests to an event or
changing or deleting an existing event; merging, deleting or pushing code; editing an existing issue or comment;
creating a pull request; or changing repository settings, collaborators or
secrets.

## Other apps

For an app that has no tools of its own, an agent gets two tools. **Search** lists
a page of the app's actions with their parameters and a `revision`; it changes
nothing. **Run** runs one named action.

- **No action is treated as a read.** Composio publishes nothing that proves an
  action only reads, so a name or a tag is not trusted. Running needs the Read and
  change level, and you approve **every call** on a card showing the app, the
  account, the action and the exact arguments (nothing is added to them). Plan mode
  and the Read level never run one.
- The backend fetches the action's description from Composio itself, checks that
  it belongs to that app, and checks the arguments against it. An action whose
  description uses anything the checker does not understand is not run. Arguments
  must be small enough to show in full, and credentials are refused.
- If Composio changes the action while a card waits, if you disconnect the
  account, lower the agent's access or remove the key, the call is cancelled, not
  run.
- Nothing that runs code, a shell or a raw request to an app is available, and
  GitHub, Gmail and Calendar stay limited to their own tools (so Gmail still
  cannot send, and GitHub still cannot delete or merge).
- An answer is cut by size, depth and count, anything that looks like a secret is
  replaced, and it is marked as other people's text. There is no per-field
  summary as for the apps with their own tools, so this is looser than those.
- A reviewed read could one day run after its first approved use; none has been
  reviewed, so every call asks.

## How changes are approved

Every change shows an approval card with its exact arguments. This includes
every action of an app without its own tools, creating a Gmail draft, and sending email: the action waits until you press Allow. There is
no "always allow" for these. Deny, Read only, or Plan mode means it does not
run. An approval covers exactly what the card showed, once.

A change is sent one time and never retried automatically. If the answer is
lost (a network error or a failure at Composio), the agent is told the outcome
is unknown and not to repeat it: check the app before asking again. If a change
went through but its reply could not be read, the agent is told it is done.

Connected apps are available in conversations you start yourself and explicitly
granted scheduled/manual routines (see below). They are not
available in webhooks or other messages that arrive from outside, and not
to an agent that has its own computer.

## What stays where

- The Composio key is encrypted with this installation's encryption key and
  kept with the other credentials. It is never returned by the API, logged or
  put in an error. Until a credential broker exists, the saved key is visible
  to this local user's agent shell commands.
- Composio holds each provider authorization. The app shows each connected
  account's app, name, status and dates, and drops everything else Composio
  returns about it.
- The agent talks to a small helper process that holds no key and makes no
  network call; the backend makes each call.
- What an agent reads from an app is added to the conversation like any other
  text, so it reaches the model provider you chose. Answers are cut to a short
  list of fields and marked as other people's text, which an agent must treat as
  information and never as your approval.

## Disconnecting and removing the key

Disconnect on the Apps page removes the account from Composio. To also remove the
app's grant at GitHub, use GitHub → Settings → Applications; that step was not
checked. Remove key deletes the key from this app only: connected accounts stay
at Composio, so disconnect them first if you want them gone.

## If something does not work

- **The agent ignores a connected app.** Check the app is allowed on that
  existing Claude or Codex agent, then start a new conversation. For GitHub,
  name the repository as `owner/name`; for Gmail and Calendar, ask for a
  specific search or date window.
- **"No account named …" or "more than one account".** Name the account to use,
  or disconnect the extra one.
- **"answered in a form this app does not read".** The message lists the
  answer's field names (never its values); include them when reporting it.
- **Composio says the key is invalid.** Check that it is a project key. A
  scoped key may also be missing permissions even when Composio reports an
  invalid key; allow Connected accounts Read, Session management Write and
  Session tool execution Write, then create and save a replacement key.
- **Composio denies a scoped key.** This can mean a permission is missing even
  when account listing worked. Allow Connected accounts Read, Session
  management Write and Session tool execution Write. Connected accounts Write
  is needed to disconnect accounts. Composio fixes scoped permissions when the
  key is created, so generate a new key after changing them. See Composio's
  [project API key permissions guide](https://docs.composio.dev/kb/guide/platform-project-api-key-permissions).
- **An unknown outcome.** Look on GitHub before asking again.

## What has been checked

The generic path and the app catalog were checked against a fake Composio that
follows Composio's published API description (OpenAPI v3.1, read on 2026-10-28):
Claude and Codex turns through the real approval gate, the checks above, and the
catalog's cache and key isolation. **Not checked against the real Composio**: the
size and paging of the real catalog, a real action description for any
non-curated app, running an action of such an app, and what Composio answers
when an app has no sign-in it supplies. Nothing in the real catalog has been
reviewed as a read.

Earlier automated checks use a fake Composio and a real runtime, approval
gate and Claude adapter. The Codex adapter now mounts the same scoped tools
and routes Codex's MCP request through that approval gate; live Codex use has
not yet been checked. By hand, on Windows with the desktop app and the web
build, the real Claude CLI, your own Composio project and a private test
repository: GitHub connecting, listing, disconnecting and approved issue
changes, plus Deny and the Read-only refusal. Gmail and Calendar agent tools
have not been run against live accounts. The desktop static UI build succeeded
and the source-checkout Mac app was relaunched, but no Gmail or Calendar call
was made in it. No automated tests were run for the Codex increment. A
packaged installer, Gmail or Calendar live calls from Codex, Linux and its
sandbox, a real lost-answer failure, and revocation at GitHub remain unchecked.

## Routine-specific app access

The routine editor binds exact actions to stable connected account IDs. Grants
start empty and do not inherit the agent's broader access. You authorize each
selected action once for that routine and account; it can then run without a
fresh approval card. The agent must also have the matching read/write app scope.
Plan mode continues to refuse writes.

In addition to existing read actions, the available write grants are:

- Send one-recipient plain-text Gmail email immediately (`gmail_send_email`).
  No cc/bcc, extra recipients, attachments or HTML are accepted.
- Create a new GitHub `campaign/` branch (`github_create_branch`).
- Commit one text file on a `campaign/` branch (`github_commit_file`). The
  existing current-blob-SHA requirement for replacements remains in force.

Other write tools, including reply drafts, are unavailable to routines. Imports
and chat-created routines receive no grant; only the person-facing editor can
assign one. Local shell commands such as `git commit` use command permissions,
independently of these connected-app grants.

Execution requires `ROUTINE_CONNECTED_APPS_ENABLED=true`, default false. Enable
only after qualifying the unattended execution safety boundary. This setting
does not implement a credential broker; local shell visibility of saved keys
remains a separate safety limitation.

Only scheduled/manual runs qualify; webhook runs, retries and runs with an agent
computer receive no connected-app tools. Each run records its starting grants.
New permissions apply on the next run; grant/account revocation stops later calls.
App content is untrusted data and cannot authorize actions.

Every write is durably reserved before provider dispatch. The same tool/account/
arguments cannot execute again in that run, including concurrent calls, process
restarts and uncertain outcomes. A crash may leave a reserved receipt; check the
external account before starting a new manual run. A new scheduled/manual run is
newly authorized work and can perform the action again. Run history shows the
latest 100 app-action receipts, including results and refusals. File Undo does
not undo email sends or repository changes. Interactive changes retain their
existing one-use approval cards.
