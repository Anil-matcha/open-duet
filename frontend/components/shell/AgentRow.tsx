"use client";

import { Crown, MoreHorizontal, Settings, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { Agent } from "@/lib/api";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { RowStatus } from "@/lib/sidebar";
import { Avatar } from "@/components/ui/Avatar";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { StatusDot } from "./StatusDot";

const ROW = "flex w-full cursor-pointer items-center gap-2.5 rounded-field py-2 pl-2 pr-2 text-left text-sm transition-colors duration-(--dur-fast) touch:py-2.5";

// One agent in the sidebar. Settings, lead and delete live in one menu (opened by the "…"
// button, a right-click or the ContextMenu key) instead of three icons always on show.
export function AgentRow({
  agent,
  href,
  selected,
  status,
  isLead,
  onOpenChat,
  onNavigate,
  onEdit,
  onChangeLead,
  onDelete,
}: {
  agent: Agent;
  // The conversation to open, or null to start a new one with this agent.
  href: string | null;
  selected: boolean;
  status: RowStatus;
  isLead: boolean;
  onOpenChat: () => void;
  onNavigate?: () => void;
  onEdit?: () => void;
  onChangeLead?: () => void;
  onDelete?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const hasMenu = Boolean(onEdit || onChangeLead || onDelete);
  const body = (
    <>
      <Avatar agentId={agent.id} name={agent.name} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{agent.name}{isLead ? " · Lead" : ""}</span>
        {agent.title ? <span className="block truncate text-xs text-muted">{agent.title}</span> : null}
      </span>
      <StatusDot status={status} />
    </>
  );
  const cls = cn(ROW, "min-w-0 flex-1", selected ? "bg-hover" : "hover:bg-hover/60", hasMenu && "pr-10");
  return (
    <li
      className="group relative flex min-w-0 items-center"
      onContextMenu={hasMenu ? (event) => { event.preventDefault(); setMenuOpen(true); } : undefined}
    >
      {href !== null ? (
        <Link href={href} onClick={onNavigate} aria-current={selected ? "page" : undefined} className={cls}>{body}</Link>
      ) : (
        <button type="button" onClick={onOpenChat} aria-current={selected ? "page" : undefined} className={cls}>{body}</button>
      )}
      {hasMenu && (
        <div className={cn("absolute right-1 top-1/2 -translate-y-1/2", !selected && !menuOpen && "opacity-0 focus-within:opacity-100 group-hover:opacity-100 touch:opacity-100")}>
          <Menu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            trigger={
              <button
                type="button"
                aria-label={t("sidebar.agentActions", { name: agent.name })}
                className="inline-flex size-8 cursor-pointer items-center justify-center rounded-field text-muted hover:bg-hover hover:text-ink touch:size-10"
              >
                <MoreHorizontal size={16} aria-hidden="true" />
              </button>
            }
          >
            {onEdit && <MenuItem onSelect={onEdit} icon={<Settings size={14} />}>{t("sidebar.agentSettings")}</MenuItem>}
            {onChangeLead && (
              <MenuItem onSelect={onChangeLead} icon={<Crown size={14} />}>{isLead ? t("sidebar.removeLead") : t("sidebar.makeLead")}</MenuItem>
            )}
            {onDelete && (
              <>
                {(onEdit || onChangeLead) && <MenuSeparator />}
                <MenuItem onSelect={onDelete} danger icon={<Trash2 size={14} />}>{t("sidebar.deleteAgent")}</MenuItem>
              </>
            )}
          </Menu>
        </div>
      )}
    </li>
  );
}
