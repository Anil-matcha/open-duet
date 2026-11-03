/**
 * Robust cross-platform copy to clipboard.
 * 1. Electron native IPC (openDots.copyText) - guaranteed in desktop app
 * 2. Modern navigator.clipboard.writeText
 * 3. Fallback invisible textarea + document.execCommand('copy')
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof window === "undefined" || !text) return false;

  // 1. Desktop native Electron IPC (if running in desktop shell)
  const openDots = (window as unknown as { openDots?: { copyText?: (t: string) => Promise<boolean> } }).openDots;
  if (typeof openDots?.copyText === "function") {
    try {
      const ok = await openDots.copyText(text);
      if (ok) return true;
    } catch {
      // Fall through to browser methods
    }
  }

  // 2. Modern async Clipboard API
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand
    }
  }

  // 3. Fallback: temporary textarea + document.execCommand('copy')
  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.top = "-9999px";
    textArea.style.left = "-9999px";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.select();
    textArea.setSelectionRange(0, textArea.value.length);
    const successful = document.execCommand("copy");
    document.body.removeChild(textArea);
    return successful;
  } catch {
    return false;
  }
}
