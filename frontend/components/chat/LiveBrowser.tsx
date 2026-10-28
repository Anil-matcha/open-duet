"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, browserViewerUrl } from "@/lib/api";
import { framePoint, keyMessage, mouseMessage, navMessage, parseServerText, textMessage, wheelMessage, type FrameSize } from "@/lib/browser-view";
import { takeover } from "@/lib/takeover";

const BUTTON = "cursor-pointer rounded border border-line px-2 py-1 text-xs disabled:opacity-50";

// Watch the agent's browser on this machine and take it over. Control is a lease, as for the desktop view: while
// you hold it the agent's browser calls are refused. Frames arrive as JPEGs and each one is acknowledged once drawn.
export function LiveBrowser({ agentId }: { agentId: number }) {
  const [state, dispatch] = useReducer(takeover, "watching");
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [address, setAddress] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const lease = useRef<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const size = useRef<FrameSize>({ w: 1280, h: 800 });
  const mounted = useRef(false);
  const generation = useRef(0);
  const active = state !== "watching" && state !== "taking";

  const send = useCallback((message: object | null) => {
    if (message && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);
  const release = useCallback(() => {
    generation.current++;
    const token = lease.current;
    lease.current = null;
    socket.current?.close(); socket.current = null;
    if (token) void api.releaseBrowserControl(agentId, token).catch(() => {});
    dispatch("release");
  }, [agentId]);
  useEffect(() => {
    mounted.current = true;
    window.addEventListener("pagehide", release);
    return () => { mounted.current = false; window.removeEventListener("pagehide", release); release(); };
  }, [release]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (lease.current) void api.browserControlHeartbeat(agentId, lease.current).catch(() => { setError("Control was handed back or this view lost its lease."); release(); });
    }, 10000);
    return () => clearInterval(timer);
  }, [active, agentId, release]);

  const connect = (ticket: string, version: number) => {
    socket.current?.close();
    const ws = new WebSocket(browserViewerUrl(agentId, ticket, location.href));
    ws.binaryType = "arraybuffer"; socket.current = ws;
    let firstFrame = false;
    const timeout = setTimeout(() => { if (!firstFrame && version === generation.current) { setError("The browser could not be shown. Try again."); release(); } }, 15000);
    ws.onmessage = (event) => {
      if (version !== generation.current) return;
      if (typeof event.data === "string") {
        const message = parseServerText(event.data);
        if (message?.kind === "size") { size.current = message.size; if (canvas.current) { canvas.current.width = message.size.w; canvas.current.height = message.size.h; } }
        else if (message?.kind === "refused") setError(message.text);
        return;
      }
      void createImageBitmap(new Blob([event.data as ArrayBuffer], { type: "image/jpeg" }))
        .then((bitmap) => { canvas.current?.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.current.width, canvas.current.height); bitmap.close(); firstFrame = true; clearTimeout(timeout); if (version === generation.current) dispatch("frame"); })
        .catch(() => {})
        .finally(() => { if (version === generation.current) send({ t: "ack" }); });
    };
    ws.onclose = () => { clearTimeout(timeout); if (version === generation.current && lease.current) { dispatch("disconnect"); setError("Connection lost. Reconnect within 20 seconds to keep control."); } };
    ws.onerror = () => { ws.close(); };
  };
  const take = async () => {
    const version = ++generation.current;
    dispatch("take"); setError(null);
    try {
      const result = await api.takeBrowserControl(agentId, lease.current ?? undefined);
      const token = result.lease_id ?? lease.current;
      if (!mounted.current || generation.current !== version) { if (result.lease_id) void api.releaseBrowserControl(agentId, result.lease_id).catch(() => {}); return; }
      if (!result.owned || !token || !result.ticket) { setError("Another view has control. Ask it to hand control back."); dispatch("failed"); return; }
      lease.current = token; dispatch("taken"); connect(result.ticket, version);
    } catch (err) { if (generation.current === version) { setError(err instanceof Error ? err.message : "Could not take control."); release(); } }
  };
  const pointer = (event: React.PointerEvent<HTMLCanvasElement>, action: "move" | "down" | "up") => {
    const point = framePoint(event.currentTarget.getBoundingClientRect(), size.current, event.clientX, event.clientY);
    if (point) send(mouseMessage(action, point, event.button));
  };
  return <section className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      {state === "watching" || state === "taking" ? <button className={BUTTON} disabled={state === "taking"} onClick={() => void take()}>{state === "taking" ? "Taking control…" : "Watch and take control of the browser"}</button> : <>
        <span className="text-xs">{state === "live" ? "You are in control of the browser" : state === "lost" ? "Connection lost" : "Connecting…"}</span>
        <button className={BUTTON} onClick={release}>Hand control back</button>
        {state === "lost" && <button className={BUTTON} onClick={() => void take()}>Reconnect</button>}
      </>}
    </div>
    {active && <>
      <canvas ref={canvas} width={1280} height={800} tabIndex={0} role="application" aria-label="The agent's browser. Click to focus; Hand control back returns control to the agent." className="aspect-[16/10] w-full touch-none rounded border border-line bg-black object-contain outline-accent"
        onPointerDown={event => { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); pointer(event, "down"); }}
        onPointerMove={event => pointer(event, "move")} onPointerUp={event => pointer(event, "up")} onContextMenu={event => event.preventDefault()}
        onWheel={event => { const point = framePoint(event.currentTarget.getBoundingClientRect(), size.current, event.clientX, event.clientY); if (point) send(wheelMessage(point, event.deltaX, event.deltaY)); }}
        onKeyDown={event => { const message = keyMessage(event, "down"); if (message) { event.preventDefault(); send(message); } }}
        onKeyUp={event => { const message = keyMessage(event, "up"); if (message) { event.preventDefault(); send(message); } }} />
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); send(navMessage(address)); setAddress(""); }}>
        <input aria-label="Address to open in the browser" placeholder="Address, for example example.com" maxLength={2048} className="min-w-0 flex-1 rounded border border-line bg-transparent px-2 py-1 text-sm" value={address} onChange={event => setAddress(event.target.value)} />
        <button type="submit" className={BUTTON}>Open</button>
      </form>
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); send(textMessage(text)); setText(""); }}>
        <input aria-label="Text to type in the browser" maxLength={2000} className="min-w-0 flex-1 rounded border border-line bg-transparent px-2 py-1 text-sm" value={text} onChange={event => setText(event.target.value)} />
        <button type="submit" className={BUTTON}>Type text</button>
      </form>
    </>}
    {error && <p role="status" className="text-xs text-warning">{error}</p>}
  </section>;
}
