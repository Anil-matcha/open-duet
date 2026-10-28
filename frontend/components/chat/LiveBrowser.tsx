"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, browserViewerUrl } from "@/lib/api";
import { canDrive, framePoint, keyMessage, mouseMessage, navMessage, parseServerText, retryDelayMs, textMessage, viewNote, viewState, wheelMessage, type FrameSize, type ViewEvent, type ViewState } from "@/lib/browser-view";

const BUTTON = "cursor-pointer rounded border border-line px-2 py-1 text-xs disabled:opacity-50";

// Watch the agent's browser on this machine, and take it over only when you choose to. Watching streams the page
// and relays nothing, so the agent keeps working; Take control is a lease, as for the desktop view: while you hold
// it the agent's browser calls are refused and your pointer and keys reach the page. Handing control back goes
// straight back to watching. Frames arrive as JPEGs and each one is acknowledged once drawn.
export function LiveBrowser({ agentId }: { agentId: number }) {
  const [state, setState] = useState<ViewState>("starting");
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [address, setAddress] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef<ViewState>("starting");
  const lease = useRef<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const size = useRef<FrameSize>({ w: 1280, h: 800 });
  const generation = useRef(0);
  const attempt = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(false);
  const watching = useRef<() => Promise<void>>(async () => {}); // the retry timers start watching again through this

  const dispatch = useCallback((event: ViewEvent) => { current.current = viewState(current.current, event); setState(current.current); }, []);
  const send = useCallback((message: object | null) => {
    if (message && canDrive(current.current) && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);
  const closeSocket = () => { const ws = socket.current; socket.current = null; ws?.close(); };
  const stopRetry = () => { if (retry.current) clearTimeout(retry.current); retry.current = null; };
  const dropLease = useCallback(() => {
    const token = lease.current;
    lease.current = null;
    if (token) void api.releaseBrowserControl(agentId, token).catch(() => {});
  }, [agentId]);

  const open = useCallback((ticket: string, version: number, driving: boolean, watchAgain: () => void) => {
    closeSocket();
    const ws = new WebSocket(browserViewerUrl(agentId, ticket, location.href));
    ws.binaryType = "arraybuffer"; socket.current = ws;
    let firstFrame = false;
    const timeout = setTimeout(() => { if (!firstFrame && version === generation.current) ws.close(); }, 15000);
    ws.onmessage = (event) => {
      if (version !== generation.current) return;
      if (typeof event.data === "string") {
        const message = parseServerText(event.data);
        if (message?.kind === "size") { size.current = message.size; if (canvas.current) { canvas.current.width = message.size.w; canvas.current.height = message.size.h; } }
        else if (message?.kind === "refused") setError(message.text);
        return;
      }
      void createImageBitmap(new Blob([event.data as ArrayBuffer], { type: "image/jpeg" }))
        .then((bitmap) => {
          canvas.current?.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.current.width, canvas.current.height); bitmap.close();
          if (version !== generation.current) return;
          firstFrame = true; clearTimeout(timeout); attempt.current = 0; setError(null); dispatch("frame");
        })
        .catch(() => {})
        .finally(() => { if (version === generation.current && socket.current === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "ack" })); });
    };
    ws.onclose = () => {
      clearTimeout(timeout);
      if (version !== generation.current || !alive.current) return;
      dispatch("drop");
      if (driving) return; // a held session keeps its lease for 20 seconds and offers Reconnect
      stopRetry(); retry.current = setTimeout(watchAgain, retryDelayMs(attempt.current++));
    };
    ws.onerror = () => { ws.close(); };
  }, [agentId, dispatch]);

  const watch: () => Promise<void> = useCallback(async () => {
    stopRetry();
    const version = ++generation.current;
    const again = () => { if (alive.current && !canDrive(current.current) && current.current !== "taking") void watching.current(); };
    try {
      const result = await api.browserViewTicket(agentId);
      if (!alive.current || version !== generation.current) return;
      open(result.ticket, version, false, again);
    } catch (err) {
      if (!alive.current || version !== generation.current) return;
      const code = (err as { code?: string | null }).code;
      const notRunning = code === "browser_not_running" || code === "browser_off";
      if (notRunning) { setError(null); dispatch("notrunning"); } else { dispatch("drop"); }
      stopRetry(); retry.current = setTimeout(again, retryDelayMs(attempt.current++, notRunning));
    }
  }, [agentId, dispatch, open]);

  useEffect(() => { watching.current = watch; }, [watch]);

  const take = async () => {
    const version = ++generation.current;
    stopRetry(); closeSocket();
    dispatch("take"); setError(null);
    try {
      const result = await api.takeBrowserControl(agentId, lease.current ?? undefined);
      const token = result.lease_id ?? lease.current;
      if (!alive.current || generation.current !== version) { if (result.lease_id) void api.releaseBrowserControl(agentId, result.lease_id).catch(() => {}); return; }
      if (!result.owned || !token || !result.ticket) { setError("Another view has control. Ask it to hand control back."); dispatch("failed"); void watch(); return; }
      lease.current = token;
      open(result.ticket, version, true, () => {});
    } catch (err) {
      if (generation.current !== version) return;
      setError(err instanceof Error ? err.message : "Could not take control.");
      dispatch("failed"); void watch();
    }
  };
  const handBack = () => {
    generation.current++; stopRetry(); closeSocket(); dropLease();
    setError(null); dispatch("release"); void watch();
  };

  useEffect(() => {
    alive.current = true;
    const start = setTimeout(() => void watch(), 0);
    const leave = () => { generation.current++; stopRetry(); closeSocket(); dropLease(); };
    window.addEventListener("pagehide", leave);
    return () => { alive.current = false; clearTimeout(start); window.removeEventListener("pagehide", leave); leave(); };
  }, [watch, dropLease]);
  useEffect(() => {
    if (state !== "driving") return;
    const timer = setInterval(() => {
      if (lease.current) void api.browserControlHeartbeat(agentId, lease.current).catch(() => { setError("Control was handed back or this view lost its lease."); handBack(); });
    }, 10000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, agentId]);

  const pointer = (event: React.PointerEvent<HTMLCanvasElement>, action: "move" | "down" | "up") => {
    const point = framePoint(event.currentTarget.getBoundingClientRect(), size.current, event.clientX, event.clientY);
    if (point) send(mouseMessage(action, point, event.button));
  };
  const driving = canDrive(state);
  return <section className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs" data-testid="live-browser-note">{viewNote(state)}</span>
      {state === "watching" && <button className={BUTTON} onClick={() => void take()}>Take control</button>}
      {state === "taking" && <button className={BUTTON} disabled>Taking control…</button>}
      {state === "lost" && <button className={BUTTON} onClick={() => void take()}>Reconnect</button>}
      {(driving || state === "lost") && <button className={BUTTON} onClick={handBack}>Hand control back</button>}
    </div>
    {state !== "waiting" && <>
      <canvas ref={canvas} width={1280} height={800} tabIndex={driving ? 0 : -1} role="application"
        aria-label={driving ? "The agent's browser. Click to focus; Hand control back returns control to the agent." : "The agent's browser, watch only. Take control to use it."}
        className={`aspect-[16/10] w-full touch-none rounded border border-line bg-black object-contain outline-accent ${driving ? "" : "pointer-events-none"}`}
        onPointerDown={event => { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); pointer(event, "down"); }}
        onPointerMove={event => pointer(event, "move")} onPointerUp={event => pointer(event, "up")} onContextMenu={event => event.preventDefault()}
        onWheel={event => { const point = framePoint(event.currentTarget.getBoundingClientRect(), size.current, event.clientX, event.clientY); if (point) send(wheelMessage(point, event.deltaX, event.deltaY)); }}
        onKeyDown={event => { const message = keyMessage(event, "down"); if (message) { event.preventDefault(); send(message); } }}
        onKeyUp={event => { const message = keyMessage(event, "up"); if (message) { event.preventDefault(); send(message); } }} />
      {driving && <>
        <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); send(navMessage(address)); setAddress(""); }}>
          <input aria-label="Address to open in the browser" placeholder="Address, for example example.com" maxLength={2048} className="min-w-0 flex-1 rounded border border-line bg-transparent px-2 py-1 text-sm" value={address} onChange={event => setAddress(event.target.value)} />
          <button type="submit" className={BUTTON}>Open</button>
        </form>
        <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); send(textMessage(text)); setText(""); }}>
          <input aria-label="Text to type in the browser" maxLength={2000} className="min-w-0 flex-1 rounded border border-line bg-transparent px-2 py-1 text-sm" value={text} onChange={event => setText(event.target.value)} />
          <button type="submit" className={BUTTON}>Type text</button>
        </form>
      </>}
    </>}
    {error && <p role="status" className="text-xs text-warning">{error}</p>}
  </section>;
}
