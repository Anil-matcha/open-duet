function safeExternalUrl(raw) {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    if ((url.protocol === "http:" || url.protocol === "https:") && (url.username || url.password)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function registerExternalLinks(webContents, { Menu, clipboard, openExternal, getWindow }) {
  const openSafe = (raw) => {
    const safe = safeExternalUrl(raw);
    if (!safe) return;
    try {
      void Promise.resolve(openExternal(safe)).catch(() => {});
    } catch {
      // An external browser may be unavailable; keep the chat usable.
    }
  };

  webContents.setWindowOpenHandler(({ url }) => {
    openSafe(url);
    return { action: "deny" };
  });

  webContents.on("context-menu", (_event, params) => {
    const template = [];
    const link = safeExternalUrl(params?.linkURL);
    const selected = typeof params?.selectionText === "string" && params.selectionText.length > 0;
    const flags = params?.editFlags ?? {};

    if (link) {
      template.push(
        { label: "Open Link", click: () => openSafe(link) },
        { label: "Copy Link Address", click: () => clipboard.writeText(link) },
      );
    }
    if (selected && flags.canCopy) {
      if (template.length) template.push({ type: "separator" });
      template.push({ role: "copy" });
    }
    if (params?.isEditable) {
      if (template.length) template.push({ type: "separator" });
      for (const [flag, role] of [["canUndo", "undo"], ["canRedo", "redo"], ["canCut", "cut"], ["canPaste", "paste"], ["canDelete", "delete"], ["canSelectAll", "selectAll"]]) {
        if (flags[flag]) template.push({ role });
      }
    } else if (!link && !selected && flags.canSelectAll) {
      template.push({ role: "selectAll" });
    }

    const window = getWindow();
    if (template.length && window && !window.isDestroyed())
      Menu.buildFromTemplate(template).popup({ window });
  });
}

module.exports = { safeExternalUrl, registerExternalLinks };
