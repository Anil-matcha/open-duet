# Connected apps

Connect an app such as GitHub once in Settings, then choose which agents may
use it. Apps are reached through [Composio](https://composio.dev) with **your
own Composio project key**; there is no shared key and nothing is sent to a
service run by this project.

Today this works for **GitHub, on Claude agents**. Gmail and Google Calendar
can be connected but no agent can use them yet. Codex and the other engines
cannot use connected apps.

## Set it up

1. **Get a key.** Create a Composio account and a project, then copy the
   project key (it starts with `ak_`).
2. **Save it.** Settings → Connected apps → paste the key → Save. The key is
   checked with Composio first, stored encrypted on this computer, and never
   shown again. To change it, use Replace key.
3. **Connect GitHub.** Choose Connect next to GitHub. Your browser opens a
   Composio page; sign in to GitHub and approve. This page notices when you are
   done. You may give the account a name; with more than one account for an app
   (up to five) the agent must say which one to use.
4. **Allow an agent.** Open a Claude agent, find Connected apps → GitHub, pick
   **Off**, **Read only** or **Read and change**, and save. New agents and
   copies of agents start with Off. If an agent still describes its old tools,
   start a new conversation.

Only the owner can do this. A paired chat device cannot see or change the key
or the connections.

## What an agent can do

| Level | It can |
|---|---|
| Read only | Read your profile, repositories, issues and pull requests, issue comments, pull request files, commits, branches and file contents (or list a folder), and search issues and pull requests. No card appears for reads. |
| Read and change | Everything above, and create an issue, comment on an issue or pull request, and close or reopen an issue. |

Not available at any level: merging, deleting, pushing code, editing a comment
or an existing issue's text, creating a pull request, and changing repository
settings, collaborators or secrets.

## How changes are approved

Every change shows a card with the exact repository, title and text. Nothing
happens until you press Allow, and there is no "always allow" for these.
Deny, or an agent set to Read only, or an agent in Plan mode, means it does not
run. An approval covers exactly what the card showed, once.

A change is sent one time and never retried automatically. If the answer is
lost (a network error or a failure at Composio), the agent is told the outcome
is unknown and not to repeat it: check GitHub before asking again. If a change
went through but its reply could not be read, the agent is told it is done.

Connected apps are used only in conversations you start yourself. They are not
available in routines, webhooks or messages that arrive from outside, and not
to an agent that has its own computer.

## What stays where

- The Composio key is encrypted with this installation's encryption key and
  kept with the other credentials. It is never returned by the API, logged or
  put in an error.
- Composio holds the GitHub authorization. The app shows each connected
  account's app, name, status and dates, and drops everything else Composio
  returns about it.
- The agent talks to a small helper process that holds no key and makes no
  network call; the backend makes each call.
- What an agent reads from GitHub is added to the conversation like any other
  text, so it reaches the model provider you chose. Answers are cut to a short
  list of fields and marked as other people's text, which an agent must treat as
  information and never as your approval.

## Disconnecting and removing the key

Disconnect in Settings removes the account from Composio. To also remove the
app's grant at GitHub, use GitHub → Settings → Applications; that step was not
checked. Remove key deletes the key from this app only: connected accounts stay
at Composio, so disconnect them first if you want them gone.

## If something does not work

- **The agent reads local files instead of GitHub.** Check the agent's level is
  not Off, then use a new conversation. Name the repository as `owner/name`.
- **"No account named …" or "more than one account".** Name the account to use,
  or disconnect the extra one.
- **"answered in a form this app does not read".** The message lists the
  answer's field names (never its values); include them when reporting it.
- **The key is no longer accepted.** Replace it in Settings.
- **An unknown outcome.** Look on GitHub before asking again.

## What has been checked

Automated tests use a fake Composio and a real runtime, approval gate and Claude
adapter. By hand, on Windows with the desktop app and the web build, the real
Claude CLI, your own Composio project and a private test repository: connecting,
listing and disconnecting (the account also disappeared from Composio's
dashboard), the reads, and creating, commenting on, closing and reopening an
issue after Allow, plus Deny and the Read-only refusal. Not run: the packaged
app, macOS, Linux and its sandbox, Gmail and Calendar (no tools exist), a real
lost-answer failure, and revocation at GitHub.
