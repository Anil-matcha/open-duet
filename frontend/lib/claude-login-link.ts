// The sign-in link Claude Code prints, shown only when it is Anthropic's own authorize page.
const HOSTS = new Set(["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"]);
// Claude Code 2.1 prints /cai/oauth/authorize; older builds print /oauth/authorize.
const AUTHORIZE_PATH = /^(\/[a-z]{1,8})?\/oauth\/authorize$/;

export function trustedLink(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && HOSTS.has(url.hostname) && AUTHORIZE_PATH.test(url.pathname)
      && !url.username && !url.password && !url.port && !url.hash && !!url.search ? value : null;
  } catch { return null; }
}
