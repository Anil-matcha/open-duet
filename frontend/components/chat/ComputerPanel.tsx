"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { api, ApiError, type Agent, type Computer, type ComputerHealth, type ComputerNetwork, type ComputerKind } from "@/lib/api";
import { LiveBrowser } from "./LiveBrowser";
import { LiveDesktop } from "./LiveDesktop";
import { DesktopPicture } from "./DesktopPicture";
import { BoatDesktop } from "./BoatDesktop";
import { NativeComputer } from "./NativeComputer";
import {
  ACTION_LABEL,
  NETWORK_MODES,
  computerStateLabel,
  computerCreationGate,
  computersUnsupported,
  effectiveState,
  hostedBrowserLine,
  imageLabel,
  lastCommandText,
  limitsText,
  nextActions,
  type ComputerAction,
} from "@/lib/computers";

const FIELD =
  "w-full rounded-md border border-line bg-transparent px-2 py-1 text-sm placeholder:text-muted";
const SMALL =
  "cursor-pointer rounded-md border border-line px-2 py-1 text-xs font-medium hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY =
  "cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 bg-accent text-accent-fg hover:opacity-90";

const REFRESH_MS = 10_000;

type Phase =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "none"; health: ComputerHealth | null }
  | { kind: "ready"; computer: Computer };

type Limits = { cpus: string; memory_mb: string; pids_limit: string; idle_minutes: string; image: string };

function limitsOf(computer: Computer): Limits {
  return {
    cpus: String(computer.cpus),
    memory_mb: String(computer.memory_mb),
    pids_limit: String(computer.pids_limit),
    idle_minutes: String(computer.idle_minutes),
    image: computer.image,
  };
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message || "That did not work.";
  return err instanceof Error ? err.message : "Could not reach the backend.";
}

// An agent's computer: whether it has one, its state, image and limits, what
// it ran last, and the buttons to make, start, stop, recreate or remove it.
export function ComputerView({
  agent, onChanged, engineSupportsComputers, engineLabel,
}: { agent: Agent; onChanged?: () => void; engineSupportsComputers: boolean | undefined; engineLabel: string }) {
  return <><NativeComputer key={agent.id} agent={agent.id} supported={agent.provider === "claude"} /><DockerComputerView agent={agent} onChanged={onChanged} engineSupportsComputers={engineSupportsComputers} engineLabel={engineLabel} /></>;
}

function DockerComputerView({
  agent,
  onChanged,
  engineSupportsComputers,
  engineLabel,
}: {
  agent: Agent;
  onChanged?: () => void;
  engineSupportsComputers: boolean | undefined;
  engineLabel: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [limits, setLimits] = useState<Limits | null>(null);
  const [kind, setKind] = useState<ComputerKind>("shell");
  const [advanced, setAdvanced] = useState(false);
  const [network, setNetwork] = useState<ComputerNetwork>("none");
  const [provider, setProvider] = useState<"docker" | "boat">("docker");
  const [boatConfigured, setBoatConfigured] = useState<boolean | null>(null);
  const [boatKey, setBoatKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const capabilityHelpId = useId();
  const createGate = computerCreationGate(engineSupportsComputers, engineLabel);

  const load = useCallback(async () => {
    try {
      const computer = await api.getAgentComputer(agent.id);
      setPhase({ kind: "ready", computer });
      setLimits((current) => current ?? limitsOf(computer));
    } catch (err) {
      if (err instanceof ApiError && computersUnsupported(err.status, err.code)) {
        setPhase({ kind: "unsupported" });
      } else if (err instanceof ApiError && err.code === "no_computer") {
        const health = await api.computersHealth().catch(() => null);
        setPhase({ kind: "none", health });
      } else {
        setError(errorText(err));
      }
    }
  }, [agent.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first read starts the panel
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (phase.kind !== "none" || phase.health?.hosted) return;
    let active = true;
    void api.boatCredentialStatus().then((result) => {
      if (active) setBoatConfigured(result.configured);
    }).catch(() => {
      if (active) setBoatConfigured(false);
    });
    return () => { active = false; };
  }, [phase.kind, phase.kind === "none" ? phase.health?.hosted : false]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result && typeof result === "object" && "id" in result && "agent_id" in result) {
        setPhase({ kind: "ready", computer: result as Computer });
        setLimits(limitsOf(result as Computer));
      } else {
        setLimits(null);
        await load();
      }
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (phase.kind === "loading") return <p className="text-sm text-muted">Loading the computer…</p>;
  if (phase.kind === "unsupported")
    return <p className="text-sm text-muted">This backend does not offer computers yet. Update it to give agents their own computer.</p>;

  const alert = error && (
    <p role="alert" className="text-sm text-danger">
      {error}
    </p>
  );

  if (phase.kind === "none") {
    const docker = phase.health;
    if (docker?.hosted) {
      return (
        <div className="space-y-2 text-sm text-muted">
          <p>{docker.error}</p>
          <p data-testid="hosted-browser-state">{hostedBrowserLine(docker)}</p>
          {docker.browser_local && <LiveBrowser agentId={agent.id} />}
        </div>
      );
    }
    return (
      <div className="space-y-3 text-sm">
        {alert}
        <p className="text-muted">
          {agent.name} can use an isolated computer. Choose where it runs; computer calls follow the agent&apos;s approval mode and any applicable saved rule.
        </p>
        <fieldset className="space-y-1">
          <legend className="text-xs text-muted">Location</legend>
          <label className="mr-4 inline-flex items-center gap-2">
            <input type="radio" name="computer-provider" checked={provider === "docker"} onChange={() => setProvider("docker")} />
            Local
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" name="computer-provider" checked={provider === "boat"} onChange={() => setProvider("boat")} />
            Cloud
          </label>
        </fieldset>
        {provider === "docker" && docker && !docker.available && (
          <p className="text-warning">Docker is not available: {docker.error}</p>
        )}
        {provider === "docker" ? (
          <p className="text-xs text-muted">Local uses an isolated Docker computer on this machine. Only its workspace folder is shared with the agent.</p>
        ) : (
          <div className="space-y-2 rounded-md border border-line p-3">
            <p className="text-xs text-muted">Cloud computers run in your Boat account, have internet access, and may incur usage charges. They auto-archive one hour after creation or resume; an agent can resume one on a later turn when auto-start is enabled. Commands and files go to the cloud computer; screenshots can be returned to the selected engine. Its files are not synced with this machine&apos;s workspace. The API key is encrypted in this Desktop profile and sent by the local backend only to authenticate Boat API requests over HTTPS; it is not sent to the agent or cloud computer.</p>
            {boatConfigured ? (
              <p className="text-xs text-muted">Boat API key saved on this device. Enter a new key to replace it.</p>
            ) : (
              <p className="text-xs text-muted">Add a Boat API key to enable cloud computers.</p>
            )}
            <form className="flex flex-wrap gap-2" onSubmit={async (event) => {
              event.preventDefault();
              if (!boatKey.trim()) return;
              setBusy(true); setError(null);
              try {
                await api.saveBoatCredential(boatKey.trim());
                setBoatConfigured(true); setBoatKey("");
              } catch (err) { setError(errorText(err)); }
              finally { setBusy(false); }
            }}>
              <input type="password" autoComplete="off" spellCheck={false} aria-label="Boat API key" placeholder="Boat API key" value={boatKey} onChange={(event) => setBoatKey(event.target.value)} className={`${FIELD} min-w-48 flex-1`} />
              <button type="submit" disabled={busy || !boatKey.trim()} className={SMALL}>Save key on this device</button>
            </form>
            {boatConfigured && <button type="button" disabled={busy} className={SMALL} onClick={() => void act(async () => {
              await api.deleteBoatCredential();
              setBoatConfigured(false);
              setBoatKey("");
            })}>Remove saved key</button>}
          </div>
        )}
        <fieldset className="space-y-1">
          <legend className="text-xs text-muted">Computer</legend>
          {(["shell", "desktop"] as const).map((value) => (
            <label key={value} className="mr-4 inline-flex items-center gap-2">
              <input type="radio" name="kind" checked={kind === value} onChange={() => setKind(value)} />
              {value === "shell" ? "Shell only" : "Desktop"}
            </label>
          ))}
          {kind === "desktop" && provider === "docker" && <p className="text-xs text-muted">Linux desktop with a browser. Build the image locally first; see desktop-image/README.md. The first build downloads several hundred MB.</p>}
          {kind === "desktop" && provider === "boat" && <p className="text-xs text-muted">Cloud Linux desktop. The first start provisions a remote desktop and installs its screen-control tools. The live view uses a secret provider link that Open Dots clears when you hand control back; the provider does not expose a link revocation control.</p>}
        </fieldset>
        {provider === "docker" && <fieldset className="space-y-1">
          <legend className="text-xs text-muted">Network</legend>
          {NETWORK_MODES.map((mode) => (
            <label key={mode.value} className="flex cursor-pointer items-start gap-2 text-xs">
              <input type="radio" name="network" checked={network === mode.value} onChange={() => setNetwork(mode.value)} />
              <span>
                <span className="font-medium">{mode.label}</span> <span className="text-muted">{mode.description}</span>
              </span>
            </label>
          ))}
        </fieldset>}
        {provider === "docker" && kind === "desktop" && network === "default" && <p className="text-xs text-warning">The browser can reach this machine&apos;s network, including your LAN and cloud metadata addresses. Use No network unless you need the internet.</p>}
        {!createGate.enabled && (
          <p id={capabilityHelpId} className="text-xs text-warning">
            {createGate.reason}
          </p>
        )}
        <button
          disabled={busy || !createGate.enabled || (provider === "boat" && !boatConfigured)}
          aria-describedby={!createGate.enabled ? capabilityHelpId : undefined}
          className={PRIMARY}
          onClick={() => act(() => api.createAgentComputer(agent.id, { provider, ...(provider === "docker" ? { network } : {}), kind }))}
        >
          {busy ? "Working…" : "Give it a computer"}
        </button>
      </div>
    );
  }

  const computer = phase.computer;
  const state = effectiveState(computer);
  const last = lastCommandText(computer);
  const actions = nextActions(computer);
  const draft = limits ?? limitsOf(computer);
  const run = (action: ComputerAction) => act(() => api.computerAction(computer.id, action));
  const saveLimits = () =>
    act(() =>
      api.updateComputer(computer.id, {
        cpus: Number(draft.cpus),
        memory_mb: Math.round(Number(draft.memory_mb)),
        pids_limit: Math.round(Number(draft.pids_limit)),
        idle_minutes: Math.round(Number(draft.idle_minutes)),
        ...(draft.image.trim() && draft.image.trim() !== computer.image ? { image: draft.image.trim() } : {}),
      })
    );

  return (
    <div className="space-y-3 text-sm">
      {alert}
      {computer.kind === "desktop" && <><DesktopPicture computer={computer} />{computer.provider === "boat" ? <BoatDesktop computerId={computer.id} /> : <LiveDesktop computerId={computer.id} />}</>}
      <div className="rounded-md border border-line p-3">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{computerStateLabel(state)}</span>
          {computer.screen_busy && <span role="status" className="text-xs text-muted">A conversation is using the screen. Other chats must wait, then take a fresh screenshot. Refused input is never queued.</span>}
          {computer.busy && <span className="rounded bg-hover px-1.5 text-xs">in use by a turn</span>}
          {computer.provider === "docker" && <span className="font-mono text-xs text-muted" title={computer.image}>
            {imageLabel(computer.image)}
            {computer.image_pinned ? " · pinned" : " · not pinned"}
          </span>}
        </p>
        <p className="mt-1 text-xs text-muted">
          {computer.provider === "boat" ? "Cloud · Internet enabled · auto-archives after 1 hour · resources managed by provider" : `${computer.provider} · ${NETWORK_MODES.find((m) => m.value === computer.network)?.label ?? computer.network} · ${limitsText(computer)}`}
          {computer.idle_minutes > 0 ? ` · stops after ${computer.idle_minutes} idle min` : " · never stops on its own"}
        </p>
        {computer.workspace_path && (
          <p className="mt-1 truncate text-xs text-muted" title={computer.workspace_path}>
            {computer.workspace_path} → {computer.guest_workspace}
          </p>
        )}
        {computer.health && !computer.health.available && (
          <p className="mt-2 text-xs text-warning">{computer.provider === "boat" ? "Cloud provider unavailable:" : "Docker is not available:"} {computer.health.error}</p>
        )}
        {computer.problem && <p className="mt-2 text-xs text-warning">{computer.problem}</p>}
        {!computer.problem && computer.last_error && state !== "running" && (
          <p className="mt-2 text-xs text-warning">{computer.last_error}</p>
        )}
        {computer.needs_recreate && (
          <p className="mt-2 text-xs text-warning">
            Settings changed since it was made. Recreate it for them to apply (files in the workspace folder stay).
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-1">
          {actions.map((action) => (
            <button key={action} disabled={busy || (computer.busy && action !== "start")} className={SMALL} onClick={() => run(action)}>
              {ACTION_LABEL[action]}
            </button>
          ))}
          <button disabled={busy} className={SMALL} onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs text-muted">Last command</p>
        {last ? (
          <>
            <p className="truncate font-mono text-xs" title={last}>
              {last}
            </p>
            {computer.last_command?.output && (
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-inset p-2 text-xs whitespace-pre-wrap">
                {computer.last_command.output}
              </pre>
            )}
          </>
        ) : (
          <p className="text-xs text-muted">Nothing has run yet.</p>
        )}
      </div>

      {computer.provider === "docker" && <button className={SMALL} aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>Advanced</button>}
      {advanced && computer.provider === "docker" && <>
      <form
        className="grid grid-cols-2 gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          saveLimits();
        }}
      >
        <label className="text-xs text-muted">
          CPUs
          <input type="number" step="0.1" min="0.1" max="64" value={draft.cpus} onChange={(e) => setLimits({ ...draft, cpus: e.target.value })} className={`${FIELD} mt-1`} />
        </label>
        <label className="text-xs text-muted">
          Memory (MB)
          <input type="number" min="128" max="262144" value={draft.memory_mb} onChange={(e) => setLimits({ ...draft, memory_mb: e.target.value })} className={`${FIELD} mt-1`} />
        </label>
        <label className="text-xs text-muted">
          Processes
          <input type="number" min="32" max="65536" value={draft.pids_limit} onChange={(e) => setLimits({ ...draft, pids_limit: e.target.value })} className={`${FIELD} mt-1`} />
        </label>
        <label className="text-xs text-muted">
          Stop after idle (min, 0 never)
          <input type="number" min="0" max="10080" value={draft.idle_minutes} onChange={(e) => setLimits({ ...draft, idle_minutes: e.target.value })} className={`${FIELD} mt-1`} />
        </label>
        <label className="col-span-2 text-xs text-muted">
          Image (applies on recreate; name@sha256:… pins it)
          <input value={draft.image} onChange={(e) => setLimits({ ...draft, image: e.target.value })} className={`${FIELD} mt-1 font-mono`} />
        </label>
        <div className="col-span-2 flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy} className={SMALL}>
            Save limits
          </button>
          <select
            aria-label="Network"
            value={computer.network}
            disabled={busy}
            onChange={(e) => act(() => api.updateComputer(computer.id, { network: e.target.value as ComputerNetwork }))}
            className="cursor-pointer rounded-md border border-line bg-transparent px-2 py-1 text-xs"
          >
            {NETWORK_MODES.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-1 text-xs text-muted">
            <input
              type="checkbox"
              checked={computer.auto_start}
              disabled={busy}
              onChange={() => act(() => api.updateComputer(computer.id, { auto_start: !computer.auto_start }))}
            />
            Start when a turn needs it
          </label>
          {computer.kind === "desktop" && <label className="flex cursor-pointer items-center gap-1 text-xs text-muted">
            <input type="checkbox" checked={computer.browser_enabled} disabled={busy || computer.busy}
              onChange={() => act(() => api.updateComputer(computer.id, { browser_enabled: !computer.browser_enabled }))} />
            Browser tools (requires the current desktop image)
          </label>}
        </div>
      </form>
      </>}

      <div className="border-t border-line pt-3">
        {confirmRemove ? (
          <p className="flex flex-wrap items-center gap-2 text-xs">
            {computer.provider === "boat" ? "Permanently remove the cloud computer and its provider data? Boat deletion runs in the background while Open Dots waits for confirmation." : "Remove the computer? Everything inside it is lost; the workspace folder stays."} {agent.name} then works on this machine again.
            <button disabled={busy} className={SMALL} onClick={() => act(() => api.deleteComputer(computer.id)).then(() => setConfirmRemove(false))}>
              Remove
            </button>
            <button disabled={busy} className={SMALL} onClick={() => setConfirmRemove(false)}>
              Keep
            </button>
          </p>
        ) : (
          <button disabled={busy || computer.busy} className={SMALL} onClick={() => setConfirmRemove(true)}>
            Remove computer…
          </button>
        )}
      </div>
    </div>
  );
}
