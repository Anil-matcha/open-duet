# Mobile app instructions

This is the native phone app for Open Dots: Expo (managed) and React Native, TypeScript, Expo Router. It pairs with the user's own server and talks to the same `/api/v1` API as the web UI, as a paired `device` with the `chat` scope (see `docs/AUTH.md`). It adds no server of its own.

## Expo changes every release

Do not trust memory for Expo, EAS or React Native APIs. Read the major version of `expo` in `package.json`, then use the matching docs at `https://docs.expo.dev/versions/v<major>.0.0/` and the index at `https://docs.expo.dev/llms.txt`.

- Add packages with `npx expo install <package>`, not `npm install`, so versions match the SDK. Dev tools go in `devDependencies`.
- `react`, `react-dom` and `react-test-renderer` must stay on the exact same version.
- Run `npx expo install --check` after dependency changes.
- Never create or edit `ios/` or `android/` by hand; they are generated from `app.json` and config plugins. They are Git-ignored.
- Routes live in `src/app/`. Keep other code (components, hooks, API client) and all tests outside it: every file in `src/app/` is bundled as a route, so a test there breaks `check:bundle`. Tests live in `src/tests/`.

## Checks (run from this directory)

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run check:bundle   # exports the JS bundle for iOS and Android; no device or Xcode needed
```

All of these work on Windows, macOS and Linux. Building or running the iOS app needs macOS; say which OS a check was actually run on. Running on a device needs a development build or Expo Go.

## Layout

- `src/app/`: screens only (Expo Router). `_layout.tsx` guards the routes: paired phones see `index` (the conversation list), `thread/[id]` and `settings`; unpaired ones see `pair` and `scan`.
- `src/components/`: pieces shared by screens (`transcript-row`, `composer`, `approval-card`, `keyboard-screen`, `markdown`). Attachments: `lib/attachments.ts` (limits, the multipart body, reading `turn.started`'s list) and `lib/pick-attachments.ts` (the two system pickers). The multipart body is built by hand because `expo/fetch` cannot send `{ uri }` parts. `lib/markdown.ts` is the Markdown reader: no HTML, and only `http(s)` links are followed.
- `src/lib/`: everything else. `server-url`, `pairing-link`, `pairing-api`, `api`, `sse` and `transcript` are plain TypeScript with no React Native imports, so they are easy to test; `credentials` is the only place the token is stored; `auth-context` holds the pairing state; `use-api` and `use-thread` tie the API to React.
- The chat reads a thread by following its event stream from the last event seen (`sse.ts`). A reconnect sends `Last-Event-ID`, and `transcript.ts` applies each stored event at most once, so a replay can never show anything twice. If the platform cannot read a response as it arrives, `followThread` falls back to paging `GET /threads/{id}/events`. Event types the app does not draw become one muted row; metadata-only types are skipped.
- Approvals: the oldest pending approval is pinned above the composer with every input of the call (long values cut, with "Show all") and Allow and Deny. The card never decides for the person: it waits for the stream's `approval.resolved` to show the result. "Always allow" rules are not part of the app.
- `src/tests/`: Jest tests. Jest's React Native environment replaces `fetch` with a stub, so unit tests pass a fake `fetch` into the `lib` functions. To check against a real server, run the compiled `lib` code under plain Node against a throwaway backend (SQLite file, the CI test key, `python -m app.auth.cli pairing-code --scope chat`).

## Rules for this package

- Scope is fixed by the maintainer's design note: pair, threads, chat with stop, approvals, plus the features added one by one afterwards (Markdown, attachments, dark theme, agent picker, rooms). Do not add voice, push, settings editing or other features without a decision.
- The app is a chat-scope client. It must reject a pairing session that has admin scope, and must not rely on hiding screens as authorization.
- The bearer token goes only into the OS secure store, never into logs, URLs or plain storage.
- Release builds talk to the server over HTTPS only. Plain HTTP works only in development builds (`__DEV__`), and `pairDevice` re-checks this before it sends a code. Any wider exception needs a maintainer decision and platform configuration.
- Decode API responses tolerantly: ignore unknown fields and show unknown event types as a generic row.
- No secrets in the repo. Signing keys, store credentials and push credentials are CI secrets only; a contributor must be able to build and run against their own server without any of them.
- Bundle id `ai.suparagent.app` and URL scheme `suparagent` are fixed. The display name in `app.json` is a placeholder.
