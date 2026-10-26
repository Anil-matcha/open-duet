# Connected apps

Connect an app in Settings, then choose which Claude agents may use it. Apps
are reached through [Composio](https://composio.dev) with **your own Composio
project key**; there is no shared key and nothing is sent to a service run by
this project.

GitHub, Gmail and Google Calendar are available to existing Claude agents.
Gmail and Calendar tools are bounded read tools; Gmail can also save a draft
reply after you approve it. Codex and the other engines cannot use connected
apps yet.

## Set it up

1. **Get a key.** Create a Composio account and a project, then copy the
   project key (it starts with `ak_`).
2. **Save it.** Settings → Connected apps → paste the key → Save. The key is
   checked with Composio first, stored encrypted on this computer, and never
   shown again. To change it, use Replace key.
3. **Connect the app.** Choose Connect next to GitHub, Gmail or Google
   Calendar. Your browser opens a Composio page; sign in to that app and
   approve. This page notices when you are done. You may give the account a
   name; with more than one account for an app (up to five) the agent must say
   which one to use.
4. **Allow an agent.** Open an existing Claude agent, find Connected apps,
   choose **Off** or **Read only** for each app; GitHub and Gmail also have
   **Read and change**. Save, start a new conversation with that agent, and
   ask naturally, for example, “Find the latest unread message from Alex and
   summarize it,” “What is on my calendar tomorrow?” or “Draft a reply to that
   email.” New agents and copies start with all apps Off. If the agent was
   already chatting, start a new conversation so it receives the updated tool
   list.

Only the owner can do this. A paired chat device cannot see or change the key
or the connections.

## What an agent can do

| Level | It can |
|---|---|
| Read only · GitHub | Read your profile, repositories, issues and pull requests, issue comments, pull request files, commits, branches and file contents (or list a folder), and search issues and pull requests. |
| Read only · Gmail | Search up to 30 messages per page, read one message or thread, and see the connected account profile. Message bodies and previews are cut to a small field allowlist. |
| Read only · Google Calendar | List calendars and event summaries in a timezone-qualified date window of up to 31 days. No calendar write tools are available. |
| Read and change · GitHub | Everything above, and create an issue, comment on an issue or pull request, and close or reopen an issue. |
| Read and change · Gmail | Read access plus creating a plain-text draft reply in an existing thread to one recipient. This only saves a draft; it does not send, forward, archive or delete email. |

For an interactive Gmail draft, the recipient and subject are supplied by the
agent and shown in the approval card. The current chat tool does not verify
that recipient against the thread's sender; check it before approving.

Not available at any level: sending or forwarding email; adding Gmail cc/bcc or
extra recipients; archive, label or delete actions; calendar event changes;
merging, deleting or pushing code; editing an existing issue or comment;
creating a pull request; or changing repository settings, collaborators or
secrets.

## How changes are approved

Every change shows an approval card with its exact arguments. This includes
creating a Gmail draft: the draft is not saved until you press Allow. There is
no "always allow" for these. Deny, Read only, or Plan mode means it does not
run. An approval covers exactly what the card showed, once.

A change is sent one time and never retried automatically. If the answer is
lost (a network error or a failure at Composio), the agent is told the outcome
is unknown and not to repeat it: check the app before asking again. If a change
went through but its reply could not be read, the agent is told it is done.

Connected apps are used only in conversations you start yourself. They are not
available in routines, webhooks or messages that arrive from outside, and not
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

Disconnect in Settings removes the account from Composio. To also remove the
app's grant at GitHub, use GitHub → Settings → Applications; that step was not
checked. Remove key deletes the key from this app only: connected accounts stay
at Composio, so disconnect them first if you want them gone.

## If something does not work

- **The agent ignores a connected app.** Check the app is allowed on that
  existing Claude agent, then start a new conversation. For GitHub, name the
  repository as `owner/name`; for Gmail and Calendar, ask for a specific search
  or date window.
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

Existing automated checks use a fake Composio and a real runtime, approval
gate and Claude adapter. By hand, on Windows with the desktop app and the web
build, the real Claude CLI, your own Composio project and a private test
repository: GitHub connecting, listing, disconnecting and approved issue
changes, plus Deny and the Read-only refusal. Gmail and Calendar agent tools
were added in source but have not been run against live accounts. The desktop
static UI build succeeded and the source-checkout Mac app was relaunched, but
no Gmail or Calendar call was made in it. Not run for this change: tests, a
packaged installer, Gmail or Calendar live calls, Linux and its sandbox, a
real lost-answer failure, and revocation at GitHub.
