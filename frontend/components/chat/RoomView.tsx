"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError, type Agent } from "@/lib/api";
import { collaboration, type Room, type RoomMessage, type SharedApproval as Approval } from "@/lib/collaboration";
import { mentionToken, queueText, roomMemberName } from "@/lib/rooms";
import { useSession } from "@/components/AuthGate";
import { Dialog } from "@/components/ui/Dialog";
import { RoomMentionComposer } from "./RoomMentionComposer";
import { RoomSettings } from "./RoomSettings";
import { SharedApproval } from "./SharedApproval";
import { Markdown } from "./Markdown";
import { useT } from "@/lib/use-i18n";

const BUTTON = "rounded-field border border-line px-3 py-1.5 text-sm hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50";
const ACTIVE_DISPATCH_STATES = ["queued", "running", "needs_input"];

function memberStatus(room: Room, approvals: Approval[], agentId: number, t: (key: string) => string) {
  const member = room.members.find(item => item.agent_id === agentId);
  if (member?.held) return t("room.held");
  const dispatch = room.dispatches.find(item => item.agent_id === agentId && ACTIVE_DISPATCH_STATES.includes(item.status));
  if (!dispatch) return null;
  if (dispatch.status === "needs_input" || approvals.some(item => item.status === "pending" && item.turn_id === dispatch.turn_id)) {
    return t("approval.waiting");
  }
  return dispatch.status === "running" ? t("room.working") : null;
}

function routeReason(reason: string, t: (key: string) => string) {
  if (reason === "mention") return t("room.mention");
  if (reason === "default") return t("room.defaultResponder");
  return reason === "chain" ? t("room.routeFollowUp") : reason.replaceAll("_", " ");
}

export function RoomView({ roomId, agents, onClose, onSelect }: { roomId: number | "new"; agents: Agent[]; onClose: () => void; onSelect: (id: number) => void }) {
  const t = useT();
  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { session } = useSession();
  const admin = session?.scopes.includes("admin") === true;
  const scroller = useRef<HTMLDivElement>(null);
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  const detailsClose = useRef<HTMLButtonElement>(null);
  const following = useRef(true);
  const orderedWork = useMemo(
    () => (room?.dispatches ?? []).filter(item => ACTIVE_DISPATCH_STATES.includes(item.status)).sort((a, b) => a.id - b.id),
    [room?.dispatches],
  );
  const duplicateNameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const member of room?.members ?? []) {
      const name = member.name.normalize("NFKC").toLocaleLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [room?.members]);
  const memberHasDuplicateName = (agentId: number) => {
    const member = room?.members.find(item => item.agent_id === agentId);
    if (!member) return false;
    const name = member.name.normalize("NFKC").toLocaleLowerCase();
    return (duplicateNameCounts.get(name) ?? 0) > 1;
  };
  const memberDisplayName = (agentId: number) => {
    const member = room?.members.find(item => item.agent_id === agentId);
    if (!member) return roomMemberName(room?.members ?? [], agentId);
    if (!memberHasDuplicateName(agentId)) return member.name;
    const agent = agents.find(item => item.id === agentId);
    const profile = agent?.title?.trim() || [agent?.provider, agent?.model].filter(Boolean).join(" · ");
    return `${member.name} · ${profile ? `${profile} · ` : ""}#${agentId}`;
  };
  const messageAuthorName = (message: RoomMessage) => {
    const author = message.author;
    if (author?.agent_id && memberHasDuplicateName(author.agent_id)) return memberDisplayName(author.agent_id);
    if (author?.label) return author.label;
    if (author?.agent_id) return roomMemberName(room?.members ?? [], author.agent_id);
    return author?.kind === "person" ? "You" : "Room";
  };
  const duplicateMemberNames = room?.members.map(member => ({
    ...member,
    name: memberDisplayName(member.agent_id),
  })) ?? [];
  const queueSummary = room ? queueText(duplicateMemberNames, orderedWork) : "";
  const pendingApprovals = approvals.filter(item => item.status === "pending");

  const refresh = useCallback(async () => {
    if (roomId === "new") return;
    const [saved, history, waiting] = await Promise.all([collaboration.room(roomId), collaboration.messages(roomId), collaboration.roomApprovals(roomId)]);
    setRoom(saved); setMessages(history); setApprovals(waiting);
    const seen = history.at(-1)?.seq;
    if (seen && saved.unread > 0 && !document.hidden) await collaboration.readRoom(saved.id, seen);
  }, [roomId]);

  useEffect(() => {
    let stopped = false;
    const load = () => { if (!document.hidden) void refresh().catch(err => { if (!stopped) setError(err instanceof ApiError ? err.message : t("room.loadError")); }); };
    load(); const timer = setInterval(load, 2000); document.addEventListener("visibilitychange", load);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [refresh, t]);

  useEffect(() => { if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [messages.length, pendingApprovals.length]);
  useEffect(() => { if (detailsOpen) detailsClose.current?.focus(); }, [detailsOpen]);

  const closeDetails = () => {
    setDetailsOpen(false);
    requestAnimationFrame(() => detailsTrigger.current?.focus());
  };
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); await refresh(); } catch (err) { setError(err instanceof ApiError ? err.message : t("room.updateError")); } finally { setBusy(false); }
  };
  const send = async (event: React.FormEvent) => {
    event.preventDefault(); if (!room || !draft.trim() || busy) return;
    const text = draft; setBusy(true); setError(null);
    try { await collaboration.postMessage(room.id, text); setDraft(""); following.current = true; await refresh(); }
    catch (err) { setError(err instanceof ApiError ? err.message : t("room.sendError")); }
    finally { setBusy(false); }
  };
  const exportRoom = async (format: "md" | "json") => {
    if (!room) return;
    setBusy(true); setError(null);
    try { const url = await api.roomExportUrl(room.id, format); const link = document.createElement("a"); link.href = url; link.download = `room-${room.id}.${format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch (err) { setError(err instanceof ApiError ? err.message : t("room.exportError")); } finally { setBusy(false); }
  };
  const deleteRoom = async () => {
    if (!room) return;
    setBusy(true); setError(null);
    try { await collaboration.deleteRoom(room.id); onClose(); }
    catch (err) { setError(err instanceof ApiError ? err.message : t("room.updateError")); }
    finally { setBusy(false); }
  };

  const setupMode = roomId === "new" || editing;
  const dialogTitle = roomId === "new" ? t("room.new") : room?.name ?? t("room.title");

  return <Dialog
    open
    title={dialogTitle}
    description={setupMode ? t("room.description") : undefined}
    size={setupMode ? "lg" : "room"}
    flush={!setupMode}
    onOpenChange={open => { if (!open) onClose(); }}
    onEscapeKeyDown={event => {
      if (detailsOpen) { event.preventDefault(); closeDetails(); return; }
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.getAttribute("role") === "combobox" && active.getAttribute("aria-expanded") === "true") event.preventDefault();
    }}
  >
    {setupMode ? <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {admin ? <RoomSettings
        key={roomId}
        room={room ?? undefined}
        agents={agents}
        onSaved={saved => { setEditing(false); setRoom(saved); onSelect(saved.id); void refresh(); }}
        onCancel={() => { if (roomId === "new") onClose(); else setEditing(false); }}
      /> : <p className="text-sm text-muted">{t("room.fullAccessRequired")}</p>}
    </div> : room ? <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-3 border-b border-line px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0 overflow-hidden">
          <ul aria-label={t("room.members")} className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {room.members.slice(0, 4).map(member => {
              const status = memberStatus(room, approvals, member.agent_id, t);
              const label = memberDisplayName(member.agent_id);
              return <li key={member.agent_id} title={status ? `${label} · ${status}` : label} aria-label={status ? `${label}: ${status}` : label} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-inset px-2 py-1 text-xs">
                <span aria-hidden="true" className="inline-flex size-5 items-center justify-center rounded-full bg-hover font-semibold text-muted">{member.name.trim().slice(0, 1).toLocaleUpperCase() || "?"}</span>
                <span className="max-w-48 truncate">{label}</span>
                {status && <span className="text-muted">{status}</span>}
              </li>;
            })}
            {room.members.length > 4 && <li className="shrink-0 rounded-full border border-line px-2 py-1 text-xs text-muted">+{room.members.length - 4}</li>}
          </ul>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            ref={detailsTrigger}
            type="button"
            className={BUTTON}
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen(value => !value)}
          >{t("room.details")}</button>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void act(() => collaboration.stopRoom(room.id))}>{t("room.stop")}</button>
        </div>
      </div>

      {error && <p role="alert" className="shrink-0 border-b border-danger/30 bg-danger/5 px-4 py-2 text-sm text-danger">{error}</p>}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <main className={`min-h-0 min-w-0 flex-1 flex-col ${detailsOpen ? "hidden md:flex" : "flex"}`}>
          {orderedWork.length > 0 && <details className="mx-3 mt-3 shrink-0 rounded-field border border-line bg-inset text-sm sm:mx-5">
            <summary className="cursor-pointer px-3 py-2 text-xs text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{queueSummary}</summary>
            <ol aria-label={t("room.title")} className="space-y-1 border-t border-line px-3 py-2">
              {orderedWork.map((dispatch, index) => {
                const waiting = dispatch.status === "needs_input" || pendingApprovals.some(item => item.turn_id === dispatch.turn_id);
                const status = waiting ? t("approval.waiting") : dispatch.status === "running" ? t("room.working") : t("room.queued");
                return <li key={dispatch.id} className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2 text-xs">
                  <span className="text-muted">{index + 1}.</span>
                  <span className="truncate">{memberDisplayName(dispatch.agent_id)}</span>
                  <span className="text-right text-muted">{status} · {routeReason(dispatch.reason, t)}</span>
                </li>;
              })}
            </ol>
          </details>}

          <div
            ref={scroller}
            onScroll={() => { const element = scroller.current; if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-4 sm:px-6 sm:py-5"
            aria-label={t("room.title")}
            tabIndex={0}
          >
            {messages.length === 0 && <p className="mx-auto max-w-xl rounded-card border border-dashed border-line p-6 text-center text-sm text-muted">{t("room.startConversation")} {t("room.tagToReply")}</p>}
            {messages.map(message => <article key={message.seq} className="mx-auto max-w-4xl space-y-1.5">
              <p className="text-xs font-semibold text-muted">{messageAuthorName(message)} <time className="ml-1 font-normal" dateTime={message.created_at}>{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></p>
              <div className="break-words text-sm leading-relaxed"><Markdown text={message.text} /></div>
              {message.source?.thread_id && <Link className="text-xs underline" href={`/chat?thread=${message.source.thread_id}`}>{t("room.seeWork")}</Link>}
            </article>)}
            {pendingApprovals.length > 0 && <section aria-label={t("header.approvals")} className="mx-auto max-w-4xl space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{t("header.approvals")}</h3>
              {pendingApprovals.map(approval => <SharedApproval key={approval.id} approval={approval} onChanged={() => void refresh()} />)}
            </section>}
            {room.dispatches.filter(item => ["failed", "stopped"].includes(item.status)).map(item => <div key={item.id} role="status" className="mx-auto flex max-w-4xl flex-wrap items-center gap-2 rounded-field border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
              <span className="flex-1">{memberDisplayName(item.agent_id)}: {item.status}{item.error_code ? ` (${item.error_code})` : ""}</span>
              {admin && <button type="button" className="underline" disabled={busy} onClick={() => void act(() => collaboration.retryDispatch(room.id, item.id))}>{t("room.retry")}</button>}
            </div>)}
          </div>

          <form onSubmit={send} className="shrink-0 border-t border-line bg-raised px-3 py-3 sm:px-5">
            <div className="mx-auto flex max-w-5xl items-end gap-2">
              <RoomMentionComposer
                value={draft}
                onChange={setDraft}
                members={room.members}
                disabled={busy}
                label={t("room.message")}
                placeholder={t("room.writeMessage")}
                everyoneLabel={t("room.everyone")}
                rows={2}
                maxLength={100000}
                className="max-h-40 min-h-12 w-full resize-y rounded-field border border-line bg-raised p-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                memberToken={member => {
                  const count = duplicateNameCounts.get(member.name.normalize("NFKC").toLocaleLowerCase()) ?? 0;
                  return mentionToken(member.name, count > 1 ? member.agent_id : undefined);
                }}
              />
              <button className={`${BUTTON} mb-0.5 shrink-0 px-4 py-2`} type="submit" disabled={busy || !draft.trim()}>{busy ? t("room.sending") : t("room.send")}</button>
            </div>
          </form>
        </main>

        {detailsOpen && <aside id="room-details-panel" role="region" aria-labelledby="room-details-title" className="flex min-h-0 w-full shrink-0 flex-col border-l border-line bg-raised md:w-80 lg:w-96">
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 id="room-details-title" className="text-sm font-semibold">{t("room.details")}</h2>
            <button ref={detailsClose} type="button" className={BUTTON} onClick={closeDetails}>{t("common.close")}</button>
          </header>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {room.bulletin && <details className="rounded-field border border-line p-3">
              <summary className="cursor-pointer text-sm font-medium">{t("room.instructions")}</summary>
              <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{room.bulletin}</p>
            </details>}
            <section aria-labelledby="room-details-members" className="space-y-2">
              <h3 id="room-details-members" className="text-xs font-semibold uppercase tracking-wide text-muted">{t("room.members")}</h3>
              <ul className="space-y-2">
                {room.members.map(member => {
                  const status = memberStatus(room, approvals, member.agent_id, t);
                  const label = memberDisplayName(member.agent_id);
                  const disambiguator = label === member.name ? null : label.slice(member.name.length + 3);
                  return <li key={member.agent_id} className="space-y-2 rounded-field border border-line p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <strong className="block truncate text-sm">{member.name}</strong>
                        {disambiguator && <span className="block truncate text-xs text-muted">{disambiguator}</span>}
                        {status && <span className={`text-xs ${member.held ? "text-warning" : "text-muted"}`}>{status}</span>}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      {admin && <button type="button" className="underline" disabled={busy} onClick={() => void act(() => collaboration.holdMember(room.id, member.agent_id, !member.held))}>{member.held ? t("room.resume") : t("room.hold")}</button>}
                      <button type="button" className="underline" disabled={busy} onClick={() => void act(() => collaboration.stopRoom(room.id, member.agent_id))}>{t("room.stopMember")}</button>
                      {member.member_thread_id && <Link className="underline" href={`/chat?thread=${member.member_thread_id}`}>{t("room.seeWork")}</Link>}
                    </div>
                  </li>;
                })}
              </ul>
            </section>
            {admin && <section aria-label={t("room.settings")} className="space-y-2 border-t border-line pt-4">
              <button type="button" className={`${BUTTON} w-full text-left`} onClick={() => { setDetailsOpen(false); setEditing(true); }}>{t("room.settings")}</button>
              <button type="button" className={`${BUTTON} w-full text-left`} disabled={busy} onClick={() => void exportRoom("md")}>{t("room.exportMarkdown")}</button>
              <button type="button" className={`${BUTTON} w-full text-left`} disabled={busy} onClick={() => void exportRoom("json")}>{t("room.exportJson")}</button>
              {confirmDelete ? <div className="space-y-2 rounded-field border border-danger/50 p-3 text-sm">
                <p>{t("room.deleteConfirm")}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={`${BUTTON} border-danger/50 text-danger`} disabled={busy} onClick={() => void deleteRoom()}>{t("room.deletePermanently")}</button>
                  <button type="button" className={BUTTON} onClick={() => setConfirmDelete(false)}>{t("room.keep")}</button>
                </div>
              </div> : <button type="button" className={`${BUTTON} w-full border-danger/50 text-danger`} disabled={busy} onClick={() => setConfirmDelete(true)}>{t("room.delete")}</button>}
            </section>}
          </div>
        </aside>}
      </div>
    </div> : !error && <p role="status" className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted">{t("room.loading")}</p>}
  </Dialog>;
}
