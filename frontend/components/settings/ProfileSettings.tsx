"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Activity,
  Bot,
  Calendar,
  Check,
  Copy,
  Cpu,
  Flame,
  Pencil,
  Share2,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { DesktopAccountDanger } from "@/components/DesktopAccountDanger";
import {
  profileApi,
  readCachedProfile,
  type ProfileDay,
  type ProfileStats,
  type UserProfile,
} from "@/lib/profile";
import { request } from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";
import { Applies } from "./Applies";
import { SaveBar } from "./SaveBar";
import { SavedConfirmation, useSavedConfirmation } from "./SavedConfirmation";

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#D97706",
  google: "#2563EB",
  openai: "#10B981",
  openrouter: "#8B5CF6",
  codex: "#059669",
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatCompact(num: number): string {
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(num);
}

function formatDateShort(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatDateLong(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function providerColor(provider: string): string {
  const key = provider.toLowerCase();
  for (const [p, col] of Object.entries(PROVIDER_COLORS)) {
    if (key.includes(p)) return col;
  }
  return "var(--accent, #6366F1)";
}

/* ─── Avatar Component ─── */
function UserAvatar({
  user,
  size = 72,
  className = "",
}: {
  user: { name?: string | null; avatar_url?: string | null; email?: string | null };
  size?: number;
  className?: string;
}) {
  const displayName = user.name?.trim() || user.email?.split("@")[0] || "User";
  const initials =
    displayName
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "U";

  if (user.avatar_url) {
    return (
      <img
        src={user.avatar_url}
        alt={displayName}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={`rounded-full object-cover ring-2 ring-line ${className}`}
      />
    );
  }

  return (
    <div
      style={{ width: size, height: size }}
      className={`flex shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-accent/80 to-accent text-accent-fg font-semibold shadow-inner ${className}`}
    >
      <span style={{ fontSize: size * 0.38 }}>{initials}</span>
    </div>
  );
}

/* ─── Skeleton Component ─── */
function ProfileSettingsSkeleton() {
  return (
    <div className="space-y-8 animate-pulse" aria-label="Loading profile">
      {/* 1. Hero Skeleton */}
      <div className="flex flex-col gap-4 rounded-xl border border-line bg-raised p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4 min-w-0">
          <div className="size-[76px] rounded-full bg-line/60 shrink-0" />
          <div className="space-y-2 min-w-0">
            <div className="h-6 w-36 rounded bg-line/60" />
            <div className="h-4 w-48 rounded bg-line/40" />
          </div>
        </div>
        <div className="flex gap-2">
          <div className="h-9 w-20 rounded bg-line/40" />
          <div className="h-9 w-28 rounded bg-line/40" />
        </div>
      </div>

      {/* 2. KPI Summary Tiles Skeleton */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-24 rounded-xl border border-line bg-raised/50 p-4" />
        ))}
      </div>

      {/* 3. Heatmap Skeleton */}
      <div className="h-44 rounded-xl border border-line bg-raised/50 p-5" />

      {/* 4. Grid Skeleton */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="h-48 rounded-xl border border-line bg-raised/50 p-5" />
        <div className="h-48 rounded-xl border border-line bg-raised/50 p-5" />
      </div>
    </div>
  );
}

function defaultEmptyStats(): ProfileStats {
  const days: ProfileDay[] = [];
  const now = new Date();
  for (let i = 364; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push({
      date: d.toISOString().slice(0, 10),
      weekday: d.getDay(),
      tokens: 0,
      messages: 0,
    });
  }
  return {
    days,
    tokens: 0,
    messages: 0,
    cost: null,
    activeDays: 0,
    peak: null,
    currentStreak: 0,
    currentStreakStart: null,
    longestStreak: 0,
    longestStreakDates: null,
    busiestWeekday: null,
    providers: [],
    models: [],
    teammates: [],
  };
}

/* ─── Main Profile Settings Component ─── */
export function ProfileSettings() {
  const confirmation = useSavedConfirmation();
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
  const [profile, setProfile] = useState<UserProfile | null>(() => {
    const cached = readCachedProfile();
    if (cached) {
      return {
        name: cached.name ?? null,
        avatar_url: cached.avatar_url ?? null,
        bio: cached.bio ?? null,
        email: cached.email ?? null,
        user_id: cached.user_id ?? null,
        is_admin: cached.is_admin ?? true,
      };
    }
    return null;
  });
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let alive = true;
    profileApi
      .getProfile()
      .then((p) => {
        if (alive) {
          setProfile(p);
        }
      })
      .catch((err) => {
        console.warn("Could not load user profile:", err);
      });

    profileApi
      .getAnnualStats(365)
      .then((s) => {
        if (alive) {
          setStats(s);
          setStatsLoading(false);
        }
      })
      .catch((err) => {
        console.warn("Could not load annual stats:", err);
        if (alive) {
          setStatsLoading(false);
        }
      });

    return () => {
      alive = false;
    };
  }, []);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await request("/desktop-account/logout", { method: "POST" });
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? `Could not sign out: ${err.message}` : "Could not sign out.");
      setSigningOut(false);
      setSignOutOpen(false);
    }
  }

  if (!mounted) {
    return <ProfileSettingsSkeleton />;
  }

  const accountName = profile?.name?.trim() || profile?.email?.split("@")[0] || "User";
  const displayStats = stats ?? (statsLoading ? null : defaultEmptyStats());

  return (
    <div className="space-y-8" data-setting-root>
      <span id="setting-profile-details" className="sr-only" />
      <span id="setting-profile-summary" className="sr-only" />
      <span id="setting-profile-activity" className="sr-only" />
      <span id="setting-profile-insights" className="sr-only" />
      <span id="setting-profile-teammates" className="sr-only" />
      <span id="setting-profile-models" className="sr-only" />
      <span id="setting-profile-account" className="sr-only" />
      {error && <Banner tone="danger">{error}</Banner>}

      {/* 1. Profile Hero Section */}
      <section
        aria-label="Profile Header"
        data-setting-id="setting-profile-details"
        className="flex flex-col gap-4 rounded-xl border border-line bg-raised p-6 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-center gap-4 min-w-0">
          <UserAvatar user={{ name: accountName, avatar_url: profile?.avatar_url, email: profile?.email }} size={76} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-xl font-semibold text-ink">{accountName}</h3>
              {profile?.is_admin && <Badge tone="accent">Admin</Badge>}
            </div>
            {profile?.email && <p className="truncate text-sm text-muted">{profile.email}</p>}
            {profile?.bio && <p className="mt-1 text-xs text-muted/80">{profile.bio}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-3"><Applies when="now" /><SavedConfirmation visible={confirmation.saved.has("profile")} /></div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" onClick={() => setShareOpen(true)}>
            <Share2 size={15} aria-hidden="true" />
            <span>Share</span>
          </Button>
          <Button variant="secondary" onClick={() => setEditOpen(true)}>
            <Pencil size={15} aria-hidden="true" />
            <span>Edit profile</span>
          </Button>
        </div>
      </section>

      {/* 2. KPI Summary Tiles */}
      {statsLoading ? (
        <section aria-label="Loading statistics" data-setting-id="setting-profile-summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5 animate-pulse">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-24 rounded-xl border border-line bg-raised/50 p-4" />
          ))}
        </section>
      ) : displayStats ? (
        <section aria-label="Annual summary statistics" data-setting-id="setting-profile-summary">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
            <div className="group rounded-xl border border-line bg-raised p-4 transition-colors hover:border-line/80">
              <dt className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <Zap size={14} className="text-accent" />
                <span>Tokens</span>
              </dt>
              <dd className="mt-2">
                <span className="text-2xl font-bold tracking-tight text-ink">
                  {formatCompact(displayStats.tokens)}
                </span>
                <span className="block text-[11px] text-faint mt-0.5">Past year</span>
              </dd>
            </div>

            <div className="group rounded-xl border border-line bg-raised p-4 transition-colors hover:border-line/80">
              <dt className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <Activity size={14} className="text-emerald-500" />
                <span>Peak day</span>
              </dt>
              <dd className="mt-2">
                <span className="text-2xl font-bold tracking-tight text-ink">
                  {displayStats.peak ? formatCompact(displayStats.peak.tokens) : "–"}
                </span>
                <span className="block text-[11px] text-faint mt-0.5">
                  {displayStats.peak ? formatDateShort(displayStats.peak.date) : "None yet"}
                </span>
              </dd>
            </div>

            <div className="group rounded-xl border border-line bg-raised p-4 transition-colors hover:border-line/80">
              <dt className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <Calendar size={14} className="text-sky-500" />
                <span>Messages</span>
              </dt>
              <dd className="mt-2">
                <span className="text-2xl font-bold tracking-tight text-ink">
                  {formatCompact(displayStats.messages)}
                </span>
                <span className="block text-[11px] text-faint mt-0.5">Past year</span>
              </dd>
            </div>

            <div className="group rounded-xl border border-line bg-raised p-4 transition-colors hover:border-line/80">
              <dt className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <Flame size={14} className="text-amber-500" />
                <span>Current streak</span>
              </dt>
              <dd className="mt-2">
                <span className="text-2xl font-bold tracking-tight text-ink">
                  {displayStats.currentStreak} {displayStats.currentStreak === 1 ? "day" : "days"}
                </span>
                <span className="block text-[11px] text-faint mt-0.5">
                  {displayStats.currentStreakStart ? `Since ${formatDateShort(displayStats.currentStreakStart)}` : "Start working today"}
                </span>
              </dd>
            </div>

            <div className="group rounded-xl border border-line bg-raised p-4 transition-colors hover:border-line/80">
              <dt className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <Flame size={14} className="text-rose-500" />
                <span>Longest streak</span>
              </dt>
              <dd className="mt-2">
                <span className="text-2xl font-bold tracking-tight text-ink">
                  {displayStats.longestStreak} {displayStats.longestStreak === 1 ? "day" : "days"}
                </span>
                <span className="block text-[11px] text-faint mt-0.5 truncate">
                  {displayStats.longestStreakDates
                    ? `${formatDateShort(displayStats.longestStreakDates.start)} – ${formatDateShort(displayStats.longestStreakDates.end)}`
                    : "No streaks yet"}
                </span>
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      {/* 3. GitHub-Style Activity Heatmap */}
      {displayStats && (
        <section
          aria-label="Activity on this computer"
          data-setting-id="setting-profile-activity"
          className="space-y-3 rounded-xl border border-line bg-raised p-5"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Activity on this computer</h3>
            <span className="text-xs text-muted">
              {displayStats.activeDays} active {displayStats.activeDays === 1 ? "day" : "days"} in the past year
            </span>
          </div>

          <ProfileHeatmap days={displayStats.days} />
        </section>
      )}

      {/* 4. Two-Column Insights & Top Teammates Grid */}
      {displayStats && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Insights Box */}
          <section data-setting-id="setting-profile-insights" className="space-y-3 rounded-xl border border-line bg-raised p-5">
            <h3 className="text-sm font-semibold text-ink">Insights</h3>
            <dl className="divide-y divide-line/60 text-sm">
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-muted">Most used provider</dt>
                <dd className="font-medium text-ink">
                  {displayStats.providers[0] ? (
                    <span className="flex items-center gap-1.5">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: providerColor(displayStats.providers[0].provider) }}
                      />
                      <span className="capitalize">{displayStats.providers[0].provider}</span>
                      <span className="text-xs text-muted">
                        · {Math.round(displayStats.providers[0].share * 100)}%
                      </span>
                    </span>
                  ) : (
                    "None yet"
                  )}
                </dd>
              </div>

              <div className="flex items-center justify-between py-2.5">
                <dt className="text-muted">Top model</dt>
                <dd className="font-mono text-xs font-medium text-ink">
                  {displayStats.models[0]?.model || "None yet"}
                </dd>
              </div>

              <div className="flex items-center justify-between py-2.5">
                <dt className="text-muted">Busiest day</dt>
                <dd className="font-medium text-ink">
                  {displayStats.busiestWeekday !== null ? WEEKDAYS[displayStats.busiestWeekday] : "None yet"}
                </dd>
              </div>

              <div className="flex items-center justify-between py-2.5">
                <dt className="text-muted">Estimated cost</dt>
                <dd className="font-medium text-ink">
                  {displayStats.cost !== null ? `$${displayStats.cost.toFixed(2)}` : "Free / API key"}
                </dd>
              </div>
            </dl>
          </section>

          {/* Most Active Teammates */}
          <section data-setting-id="setting-profile-teammates" className="space-y-3 rounded-xl border border-line bg-raised p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink">Most active teammates</h3>
              <Bot size={16} className="text-muted" />
            </div>

            {displayStats.teammates && displayStats.teammates.length > 0 ? (
              <ul className="divide-y divide-line/60 text-sm">
                {displayStats.teammates.slice(0, 4).map((row, idx) => (
                  <li key={row.agent.id} className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface border border-line text-xs font-semibold text-ink">
                        {idx + 1}
                      </div>
                      <span className="truncate font-medium text-ink">{row.agent.name}</span>
                    </div>
                    <span className="text-xs font-medium text-muted tabular-nums">
                      {formatCompact(row.tokens)} tokens
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-6 text-center text-xs text-muted">
                No agent teammates have turns recorded yet.
              </p>
            )}
          </section>
        </div>
      )}

      {/* 5. Model Distribution Breakdown */}
      {displayStats && displayStats.models && displayStats.models.length > 0 && (
        <section aria-label="Model usage distribution" data-setting-id="setting-profile-models" className="space-y-3 rounded-xl border border-line bg-raised p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Model Distribution</h3>
            <Cpu size={16} className="text-muted" />
          </div>

          <div className="space-y-2.5">
            {displayStats.models.map((m) => (
              <div key={`${m.provider}-${m.model}`} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono font-medium text-ink">{m.model}</span>
                  <span className="text-muted">
                    {formatCompact(m.tokens)} tokens ({Math.round(m.share * 100)}%)
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-line/50">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.max(2, Math.round(m.share * 100))}%`,
                      backgroundColor: providerColor(m.provider),
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 6. Connected Account Section */}
      <section data-setting-id="setting-profile-account" className="space-y-3 rounded-xl border border-line bg-raised p-5">
        <h3 className="text-sm font-semibold text-ink">Connected Account</h3>
        <p className="text-xs text-muted">
          Your profile, conversations, and engine credentials remain bound to your local device.
        </p>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line/60 bg-surface p-3.5">
          <div>
            <div className="text-sm font-medium text-ink">
              {profile?.email || "Local Profile"}
            </div>
            <div className="text-xs text-muted">
              {profile?.email ? "Signed in with email account" : "Local instance"}
            </div>
          </div>
          {profile?.email && (
            <Button variant="secondary" onClick={() => setSignOutOpen(true)}>
              Sign out
            </Button>
          )}
        </div>

        {profile?.email && (
          <div className="pt-2">
            <DesktopAccountDanger kind="reset" onDone={() => window.location.reload()} />
          </div>
        )}
      </section>

      {/* Edit Profile Dialog */}
      <ProfileEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        profile={profile}
        onSaved={(updated) =>
          {
            setProfile((prev) =>
              prev
                ? {
                    ...prev,
                    name: updated.name ?? prev.name,
                    avatar_url: updated.avatar_url ?? prev.avatar_url,
                    bio: updated.bio ?? prev.bio,
                  }
                : null
            );
            confirmation.showSaved("profile");
          }
        }
      />

      {/* Share Dialog */}
      {displayStats && (
        <ProfileShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          profile={profile}
          stats={displayStats}
        />
      )}

      {/* Sign Out Confirmation */}
      <ConfirmDialog
        open={signOutOpen}
        onOpenChange={setSignOutOpen}
        title="Sign out of Open Dots"
        description="Signing out locks your local profile. Your conversations and engine credentials remain safe on this computer."
        confirmLabel="Sign out"
        danger
        loading={signingOut}
        onConfirm={handleSignOut}
      />
    </div>
  );
}

/* ─── Heatmap Component ─── */
function ProfileHeatmap({ days }: { days: ProfileDay[] }) {
  const [hovered, setHovered] = useState<ProfileDay | null>(null);

  // Group into columns of 7 days (Sunday to Saturday)
  const { columns, months, maxTokens } = useMemo(() => {
    if (!days || days.length === 0) {
      return { columns: [], months: [], maxTokens: 0 };
    }
    const cols: Array<Array<ProfileDay | null>> = [];
    const max = Math.max(0, ...days.map((d) => d.tokens));

    // Pad beginning with nulls until the first day's weekday
    const firstWeekday = days[0]?.weekday ?? 0;
    const padded: Array<ProfileDay | null> = [
      ...Array.from({ length: firstWeekday }, () => null),
      ...days,
    ];

    while (padded.length % 7 !== 0) {
      padded.push(null);
    }

    for (let i = 0; i < padded.length; i += 7) {
      cols.push(padded.slice(i, i + 7));
    }

    // Determine month label positions
    const mLabels: Array<{ col: number; label: string }> = [];
    let lastMonth = "";
    cols.forEach((col, idx) => {
      const firstValid = col.find((d) => d !== null);
      if (!firstValid) return;
      const mStr = firstValid.date.slice(0, 7);
      if (mStr !== lastMonth) {
        lastMonth = mStr;
        const d = new Date(firstValid.date);
        mLabels.push({
          col: idx,
          label: d.toLocaleDateString([], { month: "short", timeZone: "UTC" }),
        });
      }
    });

    return { columns: cols, months: mLabels, maxTokens: max };
  }, [days]);

  function getHeatClass(day: ProfileDay | null): string {
    if (!day) return "opacity-0 pointer-events-none";
    if (day.tokens <= 0 && day.messages <= 0) return "bg-line/40 hover:ring-1 hover:ring-ink";
    if (maxTokens <= 0 || day.tokens <= 0) return "bg-accent/25 hover:ring-1 hover:ring-accent";
    const ratio = day.tokens / maxTokens;
    if (ratio <= 0.15) return "bg-accent/35 hover:ring-1 hover:ring-accent";
    if (ratio <= 0.4) return "bg-accent/55 hover:ring-1 hover:ring-accent";
    if (ratio <= 0.7) return "bg-accent/80 hover:ring-1 hover:ring-accent";
    return "bg-accent hover:ring-1 hover:ring-ink";
  }

  return (
    <div className="relative overflow-x-auto pb-1">
      {/* Month labels */}
      <div
        className="grid text-[11px] text-muted mb-1"
        style={{
          gridTemplateColumns: `repeat(${columns.length}, 13px)`,
          gap: "3px",
        }}
      >
        {months.map((m) => (
          <span
            key={`${m.col}-${m.label}`}
            style={{ gridColumn: `${m.col + 1} / span 4` }}
            className="truncate font-medium"
          >
            {m.label}
          </span>
        ))}
      </div>

      {/* Heatmap Grid */}
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${columns.length}, 13px)`,
          gridTemplateRows: "repeat(7, 13px)",
          gridAutoFlow: "column",
          gap: "3px",
        }}
      >
        {columns.map((col, cIdx) =>
          col.map((day, rIdx) => (
            <div
              key={`${cIdx}-${rIdx}`}
              onMouseEnter={() => day && setHovered(day)}
              onMouseLeave={() => setHovered(null)}
              className={`size-[13px] rounded-xs cursor-pointer transition-colors duration-150 ${getHeatClass(day)}`}
            />
          ))
        )}
      </div>

      {/* Floating Tooltip */}
      {hovered && (
        <div className="mt-2 text-xs text-ink bg-surface border border-line px-2.5 py-1 rounded-md shadow-sm inline-flex items-center gap-2">
          <strong>{formatDateLong(hovered.date)}</strong>
          <span className="text-muted">
            {formatCompact(hovered.tokens)} tokens · {hovered.messages} {hovered.messages === 1 ? "turn" : "turns"}
          </span>
        </div>
      )}

      {/* Legend */}
      <div className="mt-3 flex items-center justify-end gap-1.5 text-xs text-muted">
        <span>Less</span>
        <div className="size-[11px] rounded-xs bg-line/40" />
        <div className="size-[11px] rounded-xs bg-accent/35" />
        <div className="size-[11px] rounded-xs bg-accent/55" />
        <div className="size-[11px] rounded-xs bg-accent/80" />
        <div className="size-[11px] rounded-xs bg-accent" />
        <span>More</span>
      </div>
    </div>
  );
}

/* ─── Profile Edit Dialog ─── */
function ProfileEditDialog({
  open,
  onOpenChange,
  profile,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: UserProfile | null;
  onSaved: (updated: Partial<UserProfile>) => void;
}) {
  const [name, setName] = useState(profile?.name || "");
  const [bio, setBio] = useState(profile?.bio || "");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(profile?.avatar_url || null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const originalName = profile?.name || "";
  const originalBio = profile?.bio || "";
  const originalAvatarUrl = profile?.avatar_url || null;
  const dirty = name !== originalName || bio !== originalBio || avatarUrl !== originalAvatarUrl;

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setName(profile?.name || "");
      setBio(profile?.bio || "");
      setAvatarUrl(profile?.avatar_url || null);
      setSaveError(null);
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      if (result) { setAvatarUrl(result); setSaveError(null); }
    };
    reader.readAsDataURL(file);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      const res = await profileApi.updateProfile({
        name: name.trim() || null,
        bio: bio.trim() || null,
        avatar_url: avatarUrl,
      });
      onSaved(res);
      onOpenChange(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit profile"
      description="Update your display name, avatar, and personal bio."
      size="sm"
    >
      <form id="profile-edit-form" onSubmit={handleSave} className="space-y-4">
        {/* Avatar Picker */}
        <div className="flex flex-col items-center gap-2 pb-2">
          <UserAvatar user={{ name, avatar_url: avatarUrl }} size={84} />
          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              Change photo
            </Button>
            {avatarUrl && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => { setAvatarUrl(null); setSaveError(null); }}
              >
                Remove
              </Button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFile}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted mb-1">Display Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setSaveError(null); }}
            placeholder="e.g. Alice Developer"
            maxLength={120}
            className="w-full rounded-field border border-line bg-raised px-3 py-1.5 text-sm placeholder:text-faint focus:border-accent focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted mb-1">Bio / Role</label>
          <textarea
            value={bio}
            onChange={(e) => { setBio(e.target.value); setSaveError(null); }}
            placeholder="What you're building with Open Dots…"
            rows={2}
            maxLength={500}
            className="w-full rounded-field border border-line bg-raised px-3 py-1.5 text-sm placeholder:text-faint focus:border-accent focus:outline-none"
          />
        </div>

        <Applies when="now" />
        <SaveBar
          dirty={dirty}
          saving={saving}
          error={saveError}
          saved={false}
          saveLabel="Save changes"
          onSave={() => {
            const form = document.getElementById("profile-edit-form");
            if (form instanceof HTMLFormElement) form.requestSubmit();
          }}
          onDiscard={() => {
            setName(originalName);
            setBio(originalBio);
            setAvatarUrl(originalAvatarUrl);
            setSaveError(null);
            onOpenChange(false);
          }}
        />
      </form>
    </Dialog>
  );
}

/* ─── Profile Share Dialog ─── */
function ProfileShareDialog({
  open,
  onOpenChange,
  profile,
  stats,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: UserProfile | null;
  stats: ProfileStats;
}) {
  const [copied, setCopied] = useState(false);
  const name = profile?.name || "User";

  const shareText = useMemo(() => {
    return [
      `🚀 Open Dots Activity for ${name}`,
      `⚡ ${formatCompact(stats.tokens)} Tokens consumed`,
      `🔥 ${stats.currentStreak} Day current streak (Longest: ${stats.longestStreak} days)`,
      `🏆 Peak Day: ${stats.peak ? `${formatCompact(stats.peak.tokens)} tokens` : "N/A"}`,
      stats.models[0] ? `🤖 Top Model: ${stats.models[0].model} (${Math.round(stats.models[0].share * 100)}%)` : "",
      `💬 ${stats.messages} messages in past year`,
    ]
      .filter(Boolean)
      .join("\n");
  }, [name, stats]);

  async function copySummary() {
    const ok = await copyToClipboard(shareText);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Share activity summary"
      description="Share your Open Dots AI accomplishments and usage milestones."
      size="sm"
    >
      <div className="space-y-4">
        {/* Preview Card */}
        <div className="rounded-xl border border-line bg-surface p-5 space-y-3 font-sans">
          <div className="flex items-center gap-3">
            <UserAvatar user={{ name, avatar_url: profile?.avatar_url }} size={44} />
            <div>
              <div className="font-semibold text-ink leading-tight">{name}</div>
              <div className="text-xs text-muted">Open Dots Milestones</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs pt-1">
            <div className="rounded-lg bg-raised p-2.5 border border-line/60">
              <div className="text-muted">Tokens</div>
              <div className="text-base font-bold text-ink">{formatCompact(stats.tokens)}</div>
            </div>
            <div className="rounded-lg bg-raised p-2.5 border border-line/60">
              <div className="text-muted">Streak</div>
              <div className="text-base font-bold text-ink">{stats.currentStreak} Days</div>
            </div>
            <div className="rounded-lg bg-raised p-2.5 border border-line/60">
              <div className="text-muted">Peak Day</div>
              <div className="text-base font-bold text-ink">
                {stats.peak ? formatCompact(stats.peak.tokens) : "–"}
              </div>
            </div>
            <div className="rounded-lg bg-raised p-2.5 border border-line/60">
              <div className="text-muted">Top Model</div>
              <div className="text-xs font-semibold text-ink truncate mt-0.5">
                {stats.models[0]?.model || "None"}
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={copySummary}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied ? "Copied!" : "Copy text"}</span>
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
