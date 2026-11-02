"use client";

import { Select } from "@/components/ui/Select";
import { Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type SearchHit } from "@/lib/api";
import { snippetSegments } from "@/lib/everyday";

const MIN_CHARS = 2;
const WAIT_MS = 250;
const KIND_LABEL: Record<SearchHit["kind"], string> = { title: "Title", user: "You", assistant: "Agent" };

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// A search box over every conversation's title and messages. While a query is
// typed, its hits replace the conversation list in the scrollable body.
export function ConversationSearch({
  agentNames,
  onActive,
  onNavigate,
  children,
}: {
  agentNames?: Map<number, string>;
  onActive?: (active: boolean) => void;
  onNavigate?: () => void;
  children?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [agentId, setAgentId] = useState<number | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const q = query.trim();
  const active = q.length >= MIN_CHARS;

  useEffect(() => onActive?.(active), [active, onActive]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const timer = setTimeout(() => {
      setError(null);
      api
        .searchConversations(q, { includeArchived: archived, agentId, limit: 40 })
        .then((response) => alive && setHits(response.hits))
        .catch((err) => {
          if (!alive) return;
          setHits([]);
          setError(err instanceof ApiError ? err.message : "Could not reach the backend to search.");
        });
    }, WAIT_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, active, archived, agentId]);

  return (
    <>
      <div className="px-3 pb-2">
        <div className="relative flex items-center">
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 text-muted"
          />
          <input
            ref={inputRef}
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHits(null);
            }}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="w-full rounded-field border border-line bg-raised py-1.5 pl-8 pr-3 text-sm placeholder:text-faint transition-colors duration-(--dur-fast) focus:border-accent/60 focus:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {active ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3 px-1 pt-1 text-xs text-muted">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={archived}
                  onChange={(e) => setArchived(e.target.checked)}
                />
                <span>Include archived</span>
              </label>
              {agentNames && agentNames.size > 0 && (
                <Select
                  value={agentId ?? ""}
                  onChange={(e) => setAgentId(e.target.value === "" ? null : Number(e.target.value))}
                  aria-label="Only conversations with this agent"
                  className="max-w-36 truncate rounded border border-line bg-raised px-1 py-0.5"
                >
                  <option value="">Any agent</option>
                  {[...agentNames.entries()].map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </Select>
              )}
            </div>

            <ul aria-label="Search results" className="space-y-1">
              {hits === null && <li className="px-2 py-2 text-xs text-muted">Searching…</li>}
              {error && <li className="px-2 py-2 text-xs text-danger">{error}</li>}
              {hits?.length === 0 && !error && (
                <li className="px-2 py-2 text-xs text-muted">
                  No conversation mentions “{q}”
                  {archived ? "" : ". Archived ones are not searched unless you include them."}
                </li>
              )}
              {hits?.map((hit, index) => (
                <li key={`${hit.thread_id}-${hit.seq ?? "t"}-${index}`}>
                  <Link
                    href={`/chat?thread=${hit.thread_id}`}
                    onClick={onNavigate}
                    className="block rounded-field px-2.5 py-1.5 transition-colors duration-(--dur-fast) hover:bg-hover/60"
                  >
                    <span className="flex items-baseline gap-2 text-xs text-muted">
                      <span className="min-w-0 flex-1 truncate font-medium text-ink">
                        {hit.thread_title || `Conversation ${hit.thread_id}`}
                      </span>
                      <span className="shrink-0">{when(hit.at)}</span>
                    </span>
                    <span className="mt-0.5 line-clamp-3 break-words text-xs text-muted">
                      <span className="mr-1 text-faint">{KIND_LABEL[hit.kind]}:</span>
                      {snippetSegments(hit.snippet, hit.highlights).map((part, i) =>
                        part.mark ? (
                          <mark key={i} className="rounded-sm bg-warning/30 px-0.5 text-ink">
                            {part.text}
                          </mark>
                        ) : (
                          <span key={i}>{part.text}</span>
                        )
                      )}
                    </span>
                    {(hit.archived || (hit.agent_id != null && agentNames?.get(hit.agent_id))) && (
                      <span className="mt-0.5 block text-[11px] text-faint">
                        {[
                          hit.agent_id != null ? agentNames?.get(hit.agent_id) : null,
                          hit.archived ? "archived" : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          children
        )}
      </div>
    </>
  );
}
