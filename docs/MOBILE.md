# Phone app

A phone app for the server you run yourself. It pairs with your server as a
chat-only device, so you can read and start conversations, watch answers arrive,
stop one, and allow or deny a tool call from your phone. The server keeps
everything: agents, conversations, keys and files stay on it.

**Status: early, source only.** There is no App Store or Google Play release and
no installer yet; you run it from a source checkout (below). It has been tried on
an Android emulator in Expo Go, not on iOS or a physical phone. See
[what has been checked](#what-has-been-checked).

## What it does

- **Pair** with your server by scanning a QR code or typing the server address and
  a pairing code.
- **Conversations.** List your conversations, start a new one, open one to read its
  history. If you have agents, **New conversation** first asks which to use: the
  server's default (Claude), or one of your agents, each shown with how it asks
  before acting (asks first, accepts file edits, or plans only). Agents are made
  and edited in the web app, not on the phone. The list names the agent a
  conversation was started from.
- **Chat.** Send a message and watch the answer as it is written, with one-line
  tool steps. **Stop** ends a running answer. If the connection drops, the app
  reconnects and carries on from the last event it saw. Answers are shown as
  Markdown (headings, lists, tables, bold, italic, code, quotes, links). A wide table
  scrolls sideways so no column is cut off. There is no HTML, and only `http` and
  `https` links can be tapped; they open in your browser.
- **Search.** The **Search conversations** box on the list searches the titles
  and the messages of your conversations (what you wrote and what the agent
  answered). Every word you type must appear in one title or message; it starts
  after two letters and a short pause. Results are marked where the words match,
  are loaded a page at a time as you scroll (oldest conversations included, not
  only the newest 100), and a tap opens the conversation at the matching message,
  or the room for a room message. It uses the server's `GET /api/v1/search`
  (chat scope), which pages with `offset` since this version of the server.
- **Attachments.** The **+** button next to the message box attaches photos
  (PNG, JPEG, GIF, WebP up to 10 MB) and text files (up to 1 MB, the types in
  [everyday features](EVERYDAY.md)), up to 8 per message. Files upload as you pick
  them, you can remove one before sending, and a file the server refuses is named
  with the reason while the others still attach. Photos use the system photo
  picker and files the system file picker; the app asks for no camera or
  microphone permission for this. Sent photos show as thumbnails in the
  conversation.
- **Dark theme.** The app follows the phone's light or dark setting. There is no
  switch of its own. Text and background pairs are checked for contrast in both
  looks. Only checked by tests so far, not by eye on a device (see below).
- **Approvals.** When an agent asks to run a tool, the oldest waiting request is
  pinned above the message box with every input of the call, so you see exactly
  what would run. Allow or Deny. The first answer wins; a request already answered,
  expired or cancelled is refused with an explanation.
- **Rooms.** **Rooms** (top left of the conversation list) lists the rooms on your
  server, with an unread mark and who is working. Open one to read it as it
  happens, post to it, and tag agents with `@` (buttons add the names; `@everyone`
  asks all of them). **Stop** ends what the agents are working on. When an agent
  in the room asks to run a tool, the request is pinned with that agent's name
  and you Allow or Deny it, as in a conversation. A chat-only phone cannot
  create rooms or change who is in them; do that in the web app.
- **Settings.** The server address, this phone's name and its access (chat only),
  and **Sign out and forget this server**, which also asks the server to end the
  session. If the phone cannot reach the server at that moment, it only forgets
  the token on the phone; revoke it in **Settings → Devices** on the web app.

It does not do: push notifications (an approval reaches you only while the app is
open), creating or editing agents or rooms, engine, routine or settings management, or
more than one server. "Always allow" rules are not offered; use the web app for those.

## What your server needs

- **HTTPS.** The phone sends a token with every request, so release builds only
  connect over HTTPS. Use a reverse proxy with a certificate, or Tailscale Serve;
  see [self-hosting](SELF-HOSTING.md). Development builds also accept plain HTTP
  (seen on Android in Expo Go, not tried on iOS).
- **Agents turned on.** Conversations need `LOCAL_EXECUTION_ENABLED=true` on the
  server. Without it the app says "Your server has agents turned off".
- **Your address in `TRUSTED_HOSTS`** (see [authentication](AUTH.md)). Otherwise the
  server answers 421 and the app says it does not accept the address.

## Pair the phone

1. In the web app, open **Settings → Devices**, set Access to **Chat only**, and
   choose **Create pairing code**. A chat-only code shows a second QR code and link
   for the phone app (`suparagent://pair?server=…#code=…`) beside the browser one.
   You can also run `python -m app.auth.cli pairing-code --scope chat` from the
   server's `backend/` folder (see [self-hosting](SELF-HOSTING.md#pair-your-phone)).
2. In the app, scan the QR code, or type the server address and the code.
3. Check the address the app shows, and tap **Connect**. A scanned or opened link
   only fills in the fields; it never connects by itself.

The code works once and expires after five minutes. The app checks the code's
format first, so a typo does not count as a wrong guess toward the lockout.

The app accepts only a chat-only code. If it is handed a full-access one, it
refuses it and signs that session out on the server, so no full-access token is
left behind. The token is kept in the phone's secure storage (Keychain on iOS,
Keystore-backed storage on Android), on that device only. Revoke a phone any time
in **Settings → Devices**; the app notices and returns to pairing.

## If something goes wrong

| The app says | What to do |
|---|---|
| That code is wrong, expired or already used | Create a new chat-only code. |
| Too many wrong codes from this network | Wait the time shown; ten wrong codes lock an address out for ten minutes. |
| Your server does not accept this address | Add the name to `TRUSTED_HOSTS` on the server. |
| That address answered, but it does not look like an Open Duet server | Check the address and any proxy in front of it. |
| Could not reach the server | Check the connection and that the HTTPS certificate is trusted by the phone. |
| This app only connects over HTTPS | Use the server's HTTPS address. |
| That code gives full access | Create a code with Access set to **Chat only**. |
| Your server has agents turned off | Set `LOCAL_EXECUTION_ENABLED=true` on the server. |
| Your server signed this phone out | The phone was revoked or signed out; pair it again. |

## Run it from source

The app is in `mobile/` (Expo and React Native, TypeScript). You need Node.js 22.

```sh
cd mobile
npm ci
npx expo start        # then open it in Expo Go or an emulator
```

Expo Go runs the app without building it. A custom link such as
`suparagent://pair…` opening the app needs a development build, not Expo Go. An
Android emulator reaches the computer running the server at `10.0.2.2`; add that
name to `TRUSTED_HOSTS` for a local test. Building or running the iOS app needs
macOS.

Checks, the same as CI runs for `mobile/`:

```sh
cd mobile && npm run lint && npm run typecheck && npm test && npm run check:bundle
```

`check:bundle` exports the iOS and Android JavaScript bundles without a device or
Xcode. A standalone Android build (not Expo Go) failed on one Windows machine
on file name length limits in the native build; enable Windows long paths, build
from a short folder path, or build on EAS, WSL, Linux or macOS. See `mobile/AGENTS.md` for how the code is laid out.

## What has been checked

| Checked | How |
|---|---|
| Pairing, conversations, chat, approvals | Automated: Jest tests, lint, typecheck and a bundle export for both platforms, on Windows. The app's networking code was also run against a local backend (pairing, the live stream, a dropped connection resuming without a gap or repeat, approvals answered, errors explained). |
| The app on a screen | An Android emulator in Expo Go, against a local backend: manual chat-only pairing, staying paired after a restart, creating and listing conversations, sending a message and getting the answer, reopening history, Settings, sign-out revoking the server session, Allow and Deny on approvals that were created directly in the database, and, with a real Claude turn, a Write tool call that waited for Allow and then created the file, and Stop on a running answer (the app showed "Stopped" and the server recorded it as cancelled). |
| Markdown, attachments, dark theme, agent picker, rooms | Automated: Jest tests (including a 4.5:1 contrast check of every text and background pair in both looks), lint, typecheck and a bundle export. The app's networking code was run against a local backend: uploading a text file, a PNG, names with accents and quotes, an oversized file and an unsupported type, and reading an image back with the token; listing agents and starting a conversation from one; and, for rooms, the live stream of a room, posting, marking read, a pending request found on the right agent's thread and answered, and a chat-only device being refused when it tries to create a room. No agent was run for any of it. |
| Tables and search | Automated: Jest tests, lint, typecheck and a bundle export; the server's paged search with its own tests on SQLite. On an Android emulator in Expo Go against a throwaway backend with seeded data (no agent run): a seven-column table with long cells scrolls sideways to every column, wraps, keeps right alignment and inline code, and shows the text after it, also at 1.5x system font size; search for a word in 91 hits loaded five pages (offsets 0 to 80, each once), marked the matches, closed the keyboard on drag, and a result in the middle of a 14-turn conversation opened at that message. Not checked: a standalone build, a physical phone, iOS, a server with thousands of conversations. In that same Expo Go session the message box was still hidden under the full Gboard keyboard (see the keyboard note below). |
| QR scanning and HTTPS | The Android emulator in Expo Go: scanning the QR code from the web app filled in the server and code and waited for Connect; pairing worked over HTTPS with a valid certificate, and a server with an untrusted certificate was refused. |
| CI | The `mobile` job (install, lint, typecheck, tests, bundle export) passed on GitHub Actions on Linux. |

Partly checked: the Android keyboard. A Galaxy S23 Ultra report showed the
composer hidden and long messages cut off with the keyboard open. The keyboard
wrapper now measures its position below the navigation header, and conversation
and room lists explicitly shrink and follow the latest message on viewport
resize when the reader was already at the bottom. Approval details scroll in a
card capped at 45% of the available height, with Allow and Deny outside the
scrolling body. These changes still need verification in a rebuilt release APK
on the phone: open the Samsung keyboard, scroll a long response to its end,
type and send a multiline message, expand a long approval input and scroll it,
then repeat in a room and with the keyboard closed.

Not checked: any of the Markdown, attachments, dark theme, agent picker and rooms
screens on a device or emulator (only by tests and against the server, as above);
photos and files on iOS; a room with agents actually running in it; iOS; a
physical phone; a custom link opening the app; a release build (the HTTPS-only
behavior); very long conversations.
