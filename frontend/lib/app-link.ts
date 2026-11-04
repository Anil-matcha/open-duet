// The link the phone app opens to pair (docs/AUTH.md). No runtime imports, so node tests can load it.

export const APP_SCHEME = "suparagent";

/** `suparagent://pair?server=<origin>#code=<code>`. The code rides in the fragment, as in the web link. */
export function appPairLink(serverOrigin: string, displayCode: string): string {
  return `${APP_SCHEME}://pair?server=${encodeURIComponent(serverOrigin)}#code=${encodeURIComponent(displayCode)}`;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host.startsWith("127.") || host === "[::1]";
}

/**
 * The address the phone app should call: the API's, not always the page's. They are one origin when the UI is served by
 * the backend (a relative `apiBase`, or an absolute one on the page's own origin), and the page's origin is used as is.
 * In the split development setup (UI on :3000, API on :8000) the API's origin is used instead, and a loopback API host
 * is swapped for the host the page was opened from, because "localhost" on a phone is the phone itself.
 */
export function appServerOrigin(pageOrigin: string, apiBase: string): string {
  let page: URL;
  let api: URL;
  try {
    page = new URL(pageOrigin);
    api = new URL(apiBase);
  } catch {
    return pageOrigin;
  }
  if (api.origin === page.origin) return pageOrigin;
  if (isLoopback(api.hostname) && !isLoopback(page.hostname)) {
    api.hostname = page.hostname;
  }
  return api.origin;
}
