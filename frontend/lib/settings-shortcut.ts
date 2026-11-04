const SETTINGS_PATH = "/settings/";

type ShortcutKeyEvent = Pick<KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode" | "defaultPrevented" | "preventDefault"
>;

type ShortcutEventTarget = Pick<Document, "addEventListener" | "removeEventListener">;

export type SettingsShortcutBridge = {
  onSettingsRequested?: (listener: () => void) => (() => void) | void;
};

export function isSettingsPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith(SETTINGS_PATH);
}

export function shouldOpenSettingsForKey(
  event: ShortcutKeyEvent,
  pathname: string,
  platform: string,
  dialogOpen: boolean,
): boolean {
  const isMac = /Mac|iPhone|iPad|iPod/i.test(platform);
  const modifierPressed = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;

  return !event.defaultPrevented
    && event.key === ","
    && modifierPressed
    && !event.altKey
    && !event.shiftKey
    && !event.isComposing
    && event.keyCode !== 229
    && !dialogOpen
    && !isSettingsPath(pathname);
}

export function bindSettingsShortcut({
  eventTarget,
  pathname,
  platform,
  navigate,
  dialogOpen,
  bridge,
}: {
  eventTarget: ShortcutEventTarget;
  pathname: string;
  platform: string;
  navigate: () => void;
  dialogOpen: () => boolean;
  bridge?: SettingsShortcutBridge;
}): () => void {
  const navigateIfAllowed = () => {
    if (!isSettingsPath(pathname) && !dialogOpen()) navigate();
  };

  const onKeyDown: EventListener = (rawEvent) => {
    const event = rawEvent as KeyboardEvent;
    if (!shouldOpenSettingsForKey(event, pathname, platform, dialogOpen())) return;
    event.preventDefault();
    navigate();
  };

  eventTarget.addEventListener("keydown", onKeyDown, true);
  const unlisten = bridge?.onSettingsRequested?.(navigateIfAllowed);

  return () => {
    eventTarget.removeEventListener("keydown", onKeyDown, true);
    unlisten?.();
  };
}
