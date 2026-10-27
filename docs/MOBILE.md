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
  history. A new conversation uses your server's default engine (Claude).
- **Chat.** Send a message and watch the answer as it is written, with one-line
  tool steps. **Stop** ends a running answer. If the connection drops, the app
  reconnects and carries on from the last event it saw.
- **Approvals.** When an agent asks to run a tool, the oldest waiting request is
  pinned above the message box with every input of the call, so you see exactly
  what would run. Allow or Deny. The first answer wins; a request already answered,
  expired or cancelled is refused with an explanation.
- **Settings.** The server address, this phone's name and its access (chat only),
  and **Sign out and forget this server**, which also asks the server to end the
  session. If the phone cannot reach the server at that moment, it only forgets
  the token on the phone; revoke it in **Settings → Devices** on the web app.

It does not do: push notifications (an approval reaches you only while the app is
open), agent, engine, routine, room or settings management, attachments, Markdown
formatting of answers (answers show as plain text), more than one server, or a dark
theme. "Always allow" rules are not offered; use the web app for those.

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
Xcode. See `mobile/AGENTS.md` for how the code is laid out.

## What has been checked

| Checked | How |
|---|---|
| Pairing, conversations, chat, approvals | Automated: Jest tests, lint, typecheck and a bundle export for both platforms, on Windows. The app's networking code was also run against a local backend (pairing, the live stream, a dropped connection resuming without a gap or repeat, approvals answered, errors explained). |
| The app on a screen | An Android emulator in Expo Go, against a local backend: manual chat-only pairing, staying paired after a restart, creating and listing conversations, sending a message and getting the answer, reopening history, Settings, sign-out revoking the server session, Allow and Deny on approvals that were created directly in the database, and, with a real Claude turn, a Write tool call that waited for Allow and then created the file, and Stop on a running answer (the app showed "Stopped" and the server recorded it as cancelled). |

Partly checked: the Android keyboard. The first fix moved the message box above
the keyboard and Send worked, but its bottom edge stayed partly covered; a second
change for that was made afterwards and has not been tried.

Not checked: iOS; a physical phone; scanning the QR code; a custom link opening
the app; a release build (the HTTPS-only behavior); very long conversations.
Whether the new `mobile` CI job passes had not been checked when this was
written.
