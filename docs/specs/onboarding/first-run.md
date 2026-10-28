# First-run setup

> **Type:** spec · **Status:** source implemented, qualification pending · **Verified against:** baseline 4194bb4 plus working-tree changes on 2026-10-28

Open the desktop app and sign in to your app account using the code sent to your
email. The first sign-in asks you to associate the local profile with that account,
including any existing agents and conversations. This does not upload the data,
connect an inbox, or sign you in to an AI provider. A profile stays associated
with that account after sign-out. Use a separate desktop profile for another
account; moving data between accounts is not part of this flow.

New users continue through Welcome, Connect an AI, Your first agent and Ready.
The browser guide uses the server's workspace; the desktop guide uses the local
app workspace. The interface currently supports English and offers system,
light and dark appearance. Existing users with saved agents or the old desktop
completion flag can open the guide from Settings without repeating setup.

Choose a ready engine and model, then optionally give a starter agent a name
and purpose. Writing, research and planning suggestions are editable. Supported
team-tool engines can optionally make the agent a team lead. Creation uses
Ask-first approvals and does not enable connected apps or native desktop access.
You can keep existing agents instead. The first request opens as an unsent chat
draft: review it and press Send yourself.

Progress saves after a short pause while editing. A save conflict shows a reload
option; failed reads and saves remain retryable. Completion creates the starter
and its receipt in one database transaction, so retrying after a lost response
does not create another agent. The first-reply milestone is recorded separately,
only after the server verifies a successful turn in your conversation. Set up
later dismisses the guide; Settings can reopen it.

## Engines and optional permissions

On macOS and Linux desktop builds with Node.js/npm available, Install offers an
app-managed copy of Claude, Codex or OpenCode. This does not overwrite a system
CLI. Each operation stages in the app data folder, checks the executable's
version and atomically selects the release. Failed or cancelled updates retain
the previous managed release. Check engine status afterward, then use the
existing provider sign-in controls. Windows managed installation is not yet
supported; manual installation and provider guides remain available.

The Mac permission panel reads Accessibility and Screen Recording status, opens
only the corresponding System Settings panes, and rechecks on focus or request.
Permissions are optional for chat and do not grant any agent computer access.
Configure a particular agent's native computer separately. Other systems do not
show Mac permission actions. Connect apps from Settings only when needed.

## Account-service integration and verification limits

The desktop backend proxies the fixed account-service HTTPS endpoint at
`https://suparagent.ai/api/v1/accounts/desktop`. The service must implement email
start/verify, session lookup and sign-out before distributing this desktop build.
Existing hosted password sign-in and standalone owner-passphrase sign-in remain
separate paths. Fresh sign-in needs network access; after the short validation
cache expires, account-service failures show retry and keep the workspace locked.

Automated backend tests and browser fixtures cover core setup and account
behavior. The static UI builds and type-checks. Real email delivery, real provider
sign-in/reply, actual CLI installation downloads, OS permission dialogs, packaged
macOS/Windows installers and production endpoint deployment have not been
qualified for this change. Do not describe this as a released or fully qualified
onboarding experience until those checks pass.
