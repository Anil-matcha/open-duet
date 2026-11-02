"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Hash, Plus, Users } from "lucide-react";
import { ApiError } from "@/lib/api";
import { collaboration, type Room } from "@/lib/collaboration";
import { roomHref } from "@/lib/rooms";
import { useSession } from "@/components/AuthGate";
import { Tooltip } from "@/components/ui/Tooltip";
import { useT } from "@/lib/use-i18n";

export function RoomList({
  selected,
  onTeam,
  onNavigate,
}: {
  selected: number | "new" | null;
  onTeam: () => void;
  onNavigate?: () => void;
}) {
  const t = useT();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [teamReady, setTeamReady] = useState(false);
  const [collapsed, setCollapsed] = useState(() => selected === null);
  const { session } = useSession();
  const admin = session?.scopes.includes("admin") === true;

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (document.hidden) return;
      collaboration
        .rooms()
        .then((value) => {
          if (!cancelled) {
            setRooms(value);
            // If there are active rooms or user is currently viewing a room, keep expanded
            if (value && value.length > 0) setCollapsed(false);
          }
        })
        .catch((err) => {
          if (!cancelled && err instanceof ApiError && err.status === 404) setRooms(null);
        });
      collaboration
        .team()
        .then(() => {
          if (!cancelled) setTeamReady(true);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  if (rooms === null && !teamReady) return null;

  const roomCount = rooms?.length ?? 0;
  const showBoth = teamReady && rooms !== null;
  const sectionTitle = showBoth ? `${t("team.title")} & ${t("room.plural")}` : teamReady ? t("team.title") : t("room.plural");

  return (
    <section aria-label={sectionTitle} className="pt-2">
      <div className="flex items-center justify-between px-3 pb-1 pt-1">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted hover:text-ink cursor-pointer select-none transition-colors"
        >
          {collapsed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
          <span>{sectionTitle}</span>
          {roomCount > 0 && <span className="font-normal text-[11px] text-faint">({roomCount})</span>}
        </button>
        {/* Only show top-level Plus button when rooms-only (no team) to avoid ambiguity */}
        {!teamReady && admin && (
          <Tooltip content={t("room.new")}>
            <Link
              href={roomHref("new")}
              aria-label={t("room.new")}
              onClick={onNavigate}
              className="inline-flex size-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-ink transition-colors"
            >
              <Plus size={14} aria-hidden="true" />
            </Link>
          </Tooltip>
        )}
      </div>

      {!collapsed && (
        <div className="space-y-2 pt-1">
          {/* 1. Team Coordination */}
          {teamReady && (
            <div className="space-y-1">
              {showBoth && (
                <div className="px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                  {t("team.title")}
                </div>
              )}
              <button
                type="button"
                className="group flex w-full cursor-pointer items-center justify-between rounded-field px-2.5 py-1.5 text-left text-sm font-medium text-ink transition-colors duration-(--dur-fast) hover:bg-hover/60"
                onClick={() => {
                  onTeam();
                  onNavigate?.();
                }}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Users size={16} aria-hidden="true" className="shrink-0 text-muted group-hover:text-ink transition-colors" />
                  <span className="truncate">{t("team.coordination")}</span>
                </div>
                <span className="text-[11px] font-normal text-muted group-hover:text-ink transition-colors">
                  {t("team.manage")}
                </span>
              </button>
            </div>
          )}

          {/* 2. Collaboration Rooms */}
          {rooms !== null && (
            <div className="space-y-1">
              {showBoth && (
                <div className="flex items-center justify-between px-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                    <span>{t("room.plural")}</span>
                    {roomCount > 0 && <span className="font-normal text-faint">({roomCount})</span>}
                  </div>
                  {admin && (
                    <Tooltip content={t("room.new")}>
                      <Link
                        href={roomHref("new")}
                        aria-label={t("room.new")}
                        onClick={onNavigate}
                        className="inline-flex size-5 items-center justify-center rounded text-muted hover:bg-hover hover:text-ink transition-colors"
                      >
                        <Plus size={13} aria-hidden="true" />
                      </Link>
                    </Tooltip>
                  )}
                </div>
              )}

              {rooms.length === 0 ? (
                admin ? (
                  <Link
                    href={roomHref("new")}
                    onClick={onNavigate}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-field px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-hover/60 hover:text-ink"
                  >
                    <Plus size={13} className="shrink-0 text-muted" />
                    <span>{t("room.create")}</span>
                  </Link>
                ) : (
                  <p className="px-2.5 py-1.5 text-xs text-muted">{t("room.noRooms")}</p>
                )
              ) : (
                <ul className="space-y-0.5">
                  {rooms.map((room) => (
                    <li key={room.id}>
                      <Link
                        href={roomHref(room.id)}
                        onClick={onNavigate}
                        aria-current={selected === room.id ? "page" : undefined}
                        className={`flex items-center gap-2.5 rounded-field px-2.5 py-1.5 text-sm transition-colors duration-(--dur-fast) hover:bg-hover/60 ${
                          selected === room.id ? "bg-hover font-medium" : "text-ink"
                        }`}
                      >
                        <Hash size={15} aria-hidden="true" className="shrink-0 text-muted" />
                        <span className="min-w-0 flex-1 truncate">{room.name}</span>
                        {room.dispatches.some((item) => item.status === "running") && (
                          <span className="animate-pulse text-xs text-warning">{t("room.working")}</span>
                        )}
                        {room.unread > 0 && (
                          <span
                            className="rounded-full bg-accent px-1.5 py-0.2 text-[11px] font-medium text-accent-fg"
                            aria-label={t("room.unread", { count: room.unread })}
                          >
                            {room.unread}
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
