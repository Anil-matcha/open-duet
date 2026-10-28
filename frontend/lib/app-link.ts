// The link the phone app opens to pair (docs/AUTH.md). No runtime imports, so node tests can load it.

export const APP_SCHEME = "suparagent";

/** `suparagent://pair?server=<origin>#code=<code>`. The code rides in the fragment, as in the web link. */
export function appPairLink(serverOrigin: string, displayCode: string): string {
  return `${APP_SCHEME}://pair?server=${encodeURIComponent(serverOrigin)}#code=${encodeURIComponent(displayCode)}`;
}
