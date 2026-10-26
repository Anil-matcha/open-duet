// The prefix the pages are served under when a deployment builds with OD_BASE_PATH (for example
// /app). Next's Link and router add it themselves; use `withBase` only for addresses handed to
// `window.location`, which Next does not touch. Empty for the desktop app and plain self-hosting.
export const BASE_PATH: string = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}

// Where signed-out visitors go when the deployment has its own sign-in site (for example /login).
// Empty keeps the app's own passphrase page.
export const SIGN_IN_URL: string = process.env.NEXT_PUBLIC_SIGNIN_URL ?? "";
