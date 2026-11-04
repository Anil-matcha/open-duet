"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { api, type VersionInfo } from "@/lib/api";

export type UpdateState = {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "error";
  current: string;
  version?: string;
  percent?: number;
  message?: string;
  canDownload?: boolean;
  verified?: boolean;
};

export type UpdatesBridge = {
  run(action: "state" | "check" | "download" | "install" | "release-page"): Promise<UpdateState>;
  onState(listener: (state: UpdateState) => void): () => void;
};

function summary(state: UpdateState) {
  switch (state.status) {
    case "checking": return "Checking for updates…";
    case "available": return `Version ${state.version} is available.`;
    case "downloading": return `Downloading version ${state.version}… ${state.percent ?? 0}%`;
    case "downloaded": return `Version ${state.version} was saved to your Downloads folder${state.verified ? " and verified" : ""}.`;
    case "installing": return state.message ?? "The installer opened.";
    case "error": return state.message ?? "The update failed.";
    default: return state.message ?? "Open Duet checks for new versions in the background.";
  }
}

function DesktopAppUpdates({ bridge }: { bridge: UpdatesBridge }) {
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    let alive = true;
    void bridge.run("state").then((value) => { if (alive) setState(value); }).catch(() => {});
    const stop = bridge.onState((value) => { if (alive) setState(value); });
    return () => { alive = false; stop(); };
  }, [bridge]);

  if (!state) return null;
  const act = (action: Parameters<UpdatesBridge["run"]>[0]) => void bridge.run(action).then(setState).catch((error) => setState({ ...state, status: "error", message: String(error?.message ?? error) }));
  const working = state.status === "checking" || state.status === "downloading";

  return (
    <section aria-labelledby="app-updates" className="space-y-3 rounded-card border border-line bg-raised p-5">
      <div>
        <h3 id="app-updates" className="font-semibold">App updates</h3>
        <p className="mt-1 text-xs text-muted">You have version {state.current}. Updates come from the project&apos;s GitHub releases; nothing installs without your click.</p>
      </div>
      <p role={state.status === "error" ? "alert" : "status"} className={`text-sm ${state.status === "error" ? "text-danger" : ""}`}>{summary(state)}</p>
      <div className="flex flex-wrap gap-2">
        {state.status === "available" && state.canDownload && <Button onClick={() => act("download")}>Download version {state.version}</Button>}
        {state.status === "downloaded" && <Button onClick={() => act("install")}>Open installer</Button>}
        {(state.status === "available" || state.status === "downloaded") && <Button onClick={() => act("release-page")}>Release notes</Button>}
        {state.status === "error" && state.canDownload && <Button onClick={() => act("download")}>Try the download again</Button>}
        <Button disabled={working} onClick={() => act("check")}>{state.status === "checking" ? "Checking…" : "Check for updates"}</Button>
      </div>
    </section>
  );
}

function WebAppUpdates() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshCounter, setRefreshCounter] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const isRefresh = refreshCounter > 0;
    api.getVersionInfo(isRefresh)
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshCounter]);

  const handleCheck = () => {
    setLoading(true);
    setRefreshCounter((c) => c + 1);
  };

  if (!info && !error && loading) {
    return (
      <section aria-labelledby="app-updates" className="space-y-3 rounded-card border border-line bg-raised p-5">
        <div>
          <h3 id="app-updates" className="font-semibold">App updates</h3>
          <p className="mt-1 text-xs text-muted">Checking version…</p>
        </div>
      </section>
    );
  }

  if (!info && error) {
    return (
      <section aria-labelledby="app-updates" className="space-y-3 rounded-card border border-line bg-raised p-5">
        <div>
          <h3 id="app-updates" className="font-semibold">App updates</h3>
          <p className="mt-1 text-xs text-danger">Could not check for updates: {error}</p>
        </div>
        <Button size="sm" onClick={handleCheck}>Try again</Button>
      </section>
    );
  }

  if (!info) return null;

  const copyCommand = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(info.update_command);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {}
  };

  return (
    <section aria-labelledby="app-updates" className="space-y-3 rounded-card border border-line bg-raised p-5">
      <div>
        <h3 id="app-updates" className="font-semibold">App updates</h3>
        <p className="mt-1 text-xs text-muted">
          You have version {info.current_version}{info.commit ? ` (${info.commit})` : ""}.
          {info.install_kind ? ` Installed via ${info.install_kind}.` : ""}
        </p>
      </div>

      {info.update_available ? (
        <div className="space-y-3">
          <p role="status" className="text-sm font-medium text-accent">
            Version {info.latest_version} is available.
          </p>
          <div className="space-y-1.5">
            <p className="text-xs text-muted">Run this command to update:</p>
            <div className="flex items-center justify-between gap-3 rounded-field border border-line bg-surface p-2.5 font-mono text-xs">
              <span className="overflow-x-auto whitespace-pre">{info.update_command}</span>
              <Button size="sm" variant="secondary" onClick={copyCommand}>
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <p role="status" className="text-sm text-muted">
          {info.latest_version ? "Open Duet is up to date." : "Open Duet checks for new versions in the background."}
        </p>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        {info.release_notes_url && (
          <a
            href={info.release_notes_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center justify-center rounded-field border border-line bg-raised px-4 text-sm font-medium text-ink transition-colors hover:bg-hover"
          >
            Release notes
          </a>
        )}
        <Button disabled={loading} loading={loading} onClick={handleCheck}>
          {loading ? "Checking…" : "Check for updates"}
        </Button>
      </div>
    </section>
  );
}

export function AppUpdates() {
  const bridge = typeof window === "undefined" ? undefined : window.openDots?.updates;
  if (!bridge) {
    return <WebAppUpdates />;
  }
  return <DesktopAppUpdates bridge={bridge} />;
}
