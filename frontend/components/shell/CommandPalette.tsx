"use client";

import { Bot, MessageSquare, MessageSquarePlus, Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { Agent, Thread } from "@/lib/api";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { sidebarAgents } from "@/lib/sidebar";
import { Dialog } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Kbd";

type Command = { id: string; group: string; label: string; hint?: string; icon: ReactNode; run: () => void };

const MAX_RESULTS = 30;

// Ctrl/Cmd+K: jump to a conversation, an agent or settings from the keyboard. Mounted once
// by the chat page so the shortcut works whether the sidebar is inline or in its drawer.
export function CommandPalette({
  agents,
  threads,
  onNewChat,
}: {
  agents: Agent[] | null;
  threads: Thread[] | null;
  onNewChat: (agentId?: number) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setQuery("");
        setActive(0);
        setOpen((on) => !on);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands = useMemo<Command[]>(() => {
    const go = (run: () => void) => () => { setOpen(false); run(); };
    const names = new Map((agents ?? []).map((agent) => [agent.id, agent.name]));
    const list: Command[] = [
      { id: "new", group: t("palette.groupActions"), label: t("palette.newChat"), icon: <MessageSquarePlus size={16} />, run: go(() => onNewChat()) },
      { id: "settings", group: t("palette.groupActions"), label: t("palette.settings"), icon: <Settings size={16} />, run: go(() => router.push("/settings/")) },
    ];
    for (const agent of sidebarAgents(agents)) {
      list.push({ id: `a${agent.id}`, group: t("palette.groupAgents"), label: agent.name, hint: agent.title ?? undefined, icon: <Bot size={16} />, run: go(() => onNewChat(agent.id)) });
    }
    for (const thread of threads ?? []) {
      if (thread.archived_at !== null) continue;
      list.push({
        id: `t${thread.id}`,
        group: t("palette.groupChats"),
        label: thread.title || t("sidebar.untitled"),
        hint: thread.agent_id != null ? names.get(thread.agent_id) : undefined,
        icon: <MessageSquare size={16} />,
        run: go(() => router.push(`/chat?thread=${thread.id}`)),
      });
    }
    return list;
  }, [agents, threads, onNewChat, router]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const found = q ? commands.filter((c) => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(q)) : commands;
    return found.slice(0, MAX_RESULTS);
  }, [commands, query]);

  const current = Math.min(active, Math.max(results.length - 1, 0));
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[id="${optionId(current)}"]`)?.scrollIntoView({ block: "nearest" });
    // optionId is derived from listId, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, open]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive(results.length ? (current + 1) % results.length : 0); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(results.length ? (current - 1 + results.length) % results.length : 0); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(Math.max(results.length - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); results[current]?.run(); }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen} title={t("palette.title")} size="sm" footer={<p className="mr-auto flex items-center gap-1.5 text-xs text-muted"><Kbd>↑</Kbd><Kbd>↓</Kbd><Kbd>Enter</Kbd><Kbd>Esc</Kbd><span className="sr-only">{t("palette.hint")}</span></p>}>
      <input
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={results.length ? optionId(current) : undefined}
        aria-autocomplete="list"
        aria-label={t("palette.placeholder")}
        placeholder={t("palette.placeholder")}
        value={query}
        onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={onKeyDown}
        className="w-full rounded-field border border-line bg-inset px-3 py-2 text-sm text-ink placeholder:text-faint touch:text-base"
      />
      <ul ref={listRef} id={listId} role="listbox" aria-label={t("palette.title")} className="-mx-2 mt-3 max-h-80 overflow-y-auto">
        {results.length === 0 && <li role="presentation" className="px-3 py-6 text-center text-sm text-muted">{t("palette.empty")}</li>}
        {results.map((command, index) => (
          <li key={command.id} role="presentation">
            {(index === 0 || results[index - 1].group !== command.group) && (
              <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">{command.group}</p>
            )}
            <div
              id={optionId(index)}
              role="option"
              aria-selected={index === current}
              onMouseMove={() => setActive(index)}
              onClick={command.run}
              className={cn("flex cursor-pointer items-center gap-2.5 rounded-field px-3 py-2 text-sm touch:py-3", index === current && "bg-hover")}
            >
              <span aria-hidden="true" className="shrink-0 text-muted">{command.icon}</span>
              <span className="min-w-0 flex-1 truncate">{command.label}</span>
              {command.hint ? <span className="shrink-0 truncate text-xs text-muted">{command.hint}</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
