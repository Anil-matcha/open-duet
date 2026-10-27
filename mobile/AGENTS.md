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

## Rules for this package

- Scope is fixed by the maintainer's design note: pair, threads, chat with stop, approvals. Do not add voice, push, rooms, settings editing or other features without a decision.
- The app is a chat-scope client. It must reject a pairing session that has admin scope, and must not rely on hiding screens as authorization.
- The bearer token goes only into the OS secure store, never into logs, URLs or plain storage.
- Cleartext HTTP is off by default. Any exception must be narrow and confirmed by the user.
- Decode API responses tolerantly: ignore unknown fields and show unknown event types as a generic row.
- No secrets in the repo. Signing keys, store credentials and push credentials are CI secrets only; a contributor must be able to build and run against their own server without any of them.
- Bundle id `ai.suparagent.app` and URL scheme `suparagent` are fixed. The display name in `app.json` is a placeholder.
