"use client";

import Link from "next/link";
import { Ellipsis } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Select } from "@/components/ui/Select";
import { Tab, TabList, TabPanel, Tabs } from "@/components/ui/Tabs";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { api, ApiError, isLocalApiEndpoint, type Agent, type AgentInput, type AgentMemory, type ApprovalMode, type Engine, type OpenBotDatabasePreview, type OpenBotDatabaseProfilePreview } from "@/lib/api";
import {
  approvalModesForProvider,
  agentFileHasNotes,
  agentFileText,
  approvalModeLabel,
  memoryGauge,
  modelLabel,
  parseAgentFile,
  redactionNotice,
} from "@/lib/agents";
import {
  GROK_AGENT_EXPORT_PROMPT,
  HERMES_AGENT_EXPORT_PROMPT,
  parseExternalAgentSetup,
  type AgentMigrationPreview,
  type AgentMigrationSource,
} from "@/lib/agent-migration";
import { accountScopesToSend, scopesToSend, supportsConnectedApps, type AccountScopes, type ComposioAccount, type Scopes } from "@/lib/connected-apps";
import { ComputerView } from "./ComputerPanel";
import { EngineModelFields } from "./EngineModelFields";
import { MemoryPanel } from "./MemoryPanel";
import { TemplateSkillChoices, TemplatesGallery } from "./TemplatesGallery";
import { installTemplateSkills, skillInstallNotice, uniqueAgentName, type AgentTemplate } from "@/lib/templates";
import { useSession } from "@/components/AuthGate";
import { collaboration, type TeamState } from "@/lib/collaboration";
import { AgentSetupEntry } from "./AgentSetupEntry";
import { SkillsPanel } from "./SkillsPanel";
import { useT } from "@/lib/use-i18n";
import { AgentEditorFooter } from "./agents/AgentEditorFooter";
import { ConnectedAppsSection } from "./agents/ConnectedAppsSection";
import { filterAgents, shouldShowAgentSearch, unavailableEnginesInUse } from "./agents/agent-list";
import { draftSignature } from "./agents/draft-state";

type Draft = {
  id: number | null;
  name: string;
  title: string;
  description: string;
  instructions: string;
  provider: string;
  model: string | null;
  workspace_path: string;
  approval_mode: ApprovalMode;
  memory_enabled: boolean;
  fallback_provider: string | null;
  fallback_model: string | null;
  // Connected apps this agent may read; changed only on an existing agent.
  connector_scopes: Scopes;
  // Exact connected account IDs this agent may use.
  connector_account_scopes: AccountScopes;
  // Create only: the first contents of the agent's notes.
  starter_notes: string;
};

const EMPTY: Draft = {
  id: null,
  name: "",
  title: "",
  description: "",
  instructions: "",
  provider: "claude",
  model: null,
  workspace_path: "",
  approval_mode: "ask",
  memory_enabled: true,
  fallback_provider: null,
  fallback_model: null,
  connector_scopes: {},
  connector_account_scopes: {},
  starter_notes: "",
};

function toDraft(agent: Agent): Draft {
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title ?? "",
    description: agent.description ?? "",
    instructions: agent.instructions ?? "",
    provider: agent.provider,
    model: agent.model,
    workspace_path: agent.workspace_path ?? "",
    approval_mode: agent.approval_mode === "approve_for_me" && !approvalModesForProvider(agent.provider).some((mode) => mode.value === "approve_for_me") ? "ask" : agent.approval_mode,
    memory_enabled: agent.memory_enabled ?? true,
    fallback_provider: agent.fallback_provider ?? null,
    fallback_model: agent.fallback_model ?? null,
    connector_scopes: agent.connector_scopes ?? {},
    connector_account_scopes: agent.connector_account_scopes ?? {},
    starter_notes: "",
  };
}

function toInput(draft: Draft): AgentInput {
  const input: AgentInput = {
    name: draft.name.trim(),
    title: draft.title.trim() || null,
    description: draft.description.trim() || null,
    instructions: draft.instructions.trim(),
    provider: draft.provider,
    model: draft.model?.trim() || null,
    workspace_path: draft.workspace_path.trim() || null,
    approval_mode: draft.approval_mode,
    memory_enabled: draft.memory_enabled,
    // The agent's own engine cannot be its fallback.
    fallback_provider: draft.fallback_provider && draft.fallback_provider !== draft.provider ? draft.fallback_provider : null,
    fallback_model: draft.fallback_provider && draft.fallback_provider !== draft.provider ? draft.fallback_model?.trim() || null : null,
  };
  if (draft.id === null && draft.starter_notes.trim()) input.starter_notes = draft.starter_notes;
  if (draft.id !== null) {
    input.connector_scopes = scopesToSend(draft.connector_scopes, draft.provider);
    input.connector_account_scopes = accountScopesToSend(draft.connector_account_scopes, draft.connector_scopes, draft.provider);
  }
  return input;
}

// The notes editor: what was loaded, what is typed, and a save refused because
// the agent changed the file meanwhile.
type NotesState = {
  agent: Agent;
  memory: AgentMemory | null;
  text: string;
  conflict: boolean;
  saved: string | null;
};

type ExportState = { agent: Agent; includeNotes: boolean; notice: string | null };
type ImportState = {
  document: Record<string, unknown>;
  name: string;
  hasNotes: boolean;
  includeNotes: boolean;
  migration?: AgentMigrationPreview;
};
type MigrationState = { source: AgentMigrationSource | null; text: string; copied: boolean };

const FIELD =
  "w-full rounded-md border border-line bg-transparent px-3 py-1.5 text-sm placeholder:text-muted";
const BUTTON =
  "cursor-pointer rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";
const SMALL =
  "cursor-pointer rounded-md border border-line px-2 py-1 text-xs font-medium hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY =
  "cursor-pointer rounded-md px-4 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 bg-accent text-accent-fg hover:opacity-90";
const GAUGE_COLOR = { ok: "bg-success", near: "bg-warning", over: "bg-danger" } as const;
type EditorSection = "basics" | "model" | "apps" | "memory";

function saveFile(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function SetupEntryDisclosure({ agents, engines, onStart, onCreateLead }: {
  agents: Agent[];
  engines: Engine[];
  onStart: (id: number) => void;
  onCreateLead: () => void;
}) {
  return (
    <details>
      <summary className="w-fit cursor-pointer list-none rounded-field py-1 text-sm font-medium text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        Create by chatting
      </summary>
      <div className="mt-3">
        <AgentSetupEntry agents={agents} engines={engines} onStart={onStart} onCreateLead={onCreateLead} />
      </div>
    </details>
  );
}

// List, create, edit, duplicate, pin, archive, export and import named agents,
// and edit each agent's notes. A new model or approval mode applies to an agent's
// next message; new instructions and notes reach conversations started after them.
export function AgentsPanel({
  agents,
  onClose,
  onChanged,
  startCreating = false,
  initialDeleteAgent = null,
  onCreated,
  onSetupChat,
  initialEditAgent = null,
}: {
  agents: Agent[];
  onSetupChat?: (id: number) => void;
  initialEditAgent?: Agent | null;
  onClose: () => void;
  // Open straight on the new-agent form (the sidebar's New agent button).
  startCreating?: boolean;
  // Open with the delete confirmation for an agent selected from the sidebar.
  initialDeleteAgent?: Agent | null;
  // Called after any change, so the page reads the agent list again.
  onChanged: () => void;
  // Called with an agent made from a template, so the page can select it.
  onCreated?: (agent: Agent) => void;
}) {
  // The template browser, and the template (with the suggested skills still ticked) the form was filled from.
  const [gallery, setGallery] = useState(false);
  const [fromTemplate, setFromTemplate] = useState<{ template: AgentTemplate; skills: string[] } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(() => initialEditAgent ? toDraft(initialEditAgent) : startCreating ? EMPTY : null);
  const [originalDraft, setOriginalDraft] = useState<Draft | null>(() => initialEditAgent ? toDraft(initialEditAgent) : startCreating ? EMPTY : null);
  const [editorSection, setEditorSection] = useState<EditorSection>("basics");
  const [notes, setNotes] = useState<NotesState | null>(null);
  const [exporting, setExporting] = useState<ExportState | null>(null);
  const [importing, setImporting] = useState<ImportState | null>(null);
  const [migration, setMigration] = useState<MigrationState | null>(null);
  const [openBotDatabase, setOpenBotDatabase] = useState<OpenBotDatabasePreview | null>(null);
  const [computerOf, setComputerOf] = useState<Agent | null>(null);
  const [skillsOf, setSkillsOf] = useState<Agent | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Agent | null>(initialDeleteAgent);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [closeAfterDiscard, setCloseAfterDiscard] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [agentFilter, setAgentFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [engines, setEngines] = useState<Engine[]>([]);
  // The accounts connected on the Apps page: every app with one can be allowed for an agent. Empty when none, or when this
  // device may not see them (only the owner can).
  const [appAccounts, setAppAccounts] = useState<ComposioAccount[] | null>(null);
  const { session } = useSession();
  const t = useT();
  const admin = session?.scopes.includes("admin") === true;
  const [team, setTeam] = useState<TeamState | null>(null);
  const [roleChoice, setRoleChoice] = useState<{ id: number | null; value: boolean } | null>(null);
  const [memberChoices, setMemberChoices] = useState<Record<number, boolean>>({});
  const isLead = draft !== null && (roleChoice?.id === draft.id ? roleChoice.value : draft.id !== null && team?.team?.lead_agent_id === draft.id);
  const roleSupported = engines.some(engine => engine.id === draft?.provider && engine.capabilities.mcp);
  useEffect(() => {
    let live = true;
    api.getComposioStatus().then((value) => value.configured ? api.listComposioAccounts() : []).then((value) => { if (live) setAppAccounts(value); }).catch(() => { if (live) setAppAccounts([]); });
    return () => { live = false; };
  }, []);
  useEffect(() => { let live = true; collaboration.team().then(value => { if (live) setTeam(value); }).catch(() => {}); return () => { live = false; }; }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  const openBotDatabaseInput = useRef<HTMLInputElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const keepAgentRef = useRef<HTMLButtonElement>(null);
  const deleteConfirmationRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const canReadOpenBotDatabase = isLocalApiEndpoint();

  useEffect(() => {
    let cancelled = false;
    api.getEngines().then((items) => { if (!cancelled) setEngines(items); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (discardConfirm) keepEditingRef.current?.focus();
  }, [discardConfirm]);

  useEffect(() => {
    if (!deleteConfirm) return;
    deleteConfirmationRef.current?.scrollIntoView({ block: "nearest" });
    const focusFrame = window.requestAnimationFrame(() => keepAgentRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [deleteConfirm]);

  const errorText = (err: unknown) =>
    err instanceof ApiError ? err.message || "That did not work." : err instanceof Error ? err.message : "Could not reach the backend.";

  const run = async (action: () => Promise<unknown>, done?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      done?.();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!draft || draft.name.trim() === "") return;
    const input = toInput(draft);
    if (draft.id === null && fromTemplate) return createFromTemplate(input, fromTemplate);
    run(
      async () => {
        const agent = draft.id === null ? await api.createAgent({ ...input, make_lead: isLead }) : await api.updateAgent(draft.id, { ...input, ...(roleChoice?.id === draft.id ? { make_lead: isLead } : {}) });
        // Creation is already saved; subsequent coordination errors must not create another agent on retry.
        const savedDraft = toDraft(agent);
        setDraft(savedDraft);
        setOriginalDraft(savedDraft);
        setRoleChoice({ id: agent.id, value: isLead });
        setTeam(await collaboration.team());
        if (isLead) for (const [id, included] of Object.entries(memberChoices)) {
          if (Number(id) === agent.id) continue;
          if (included) await collaboration.addMember(Number(id));
          else if (team?.agents.some(member => member.id === Number(id))) await collaboration.removeMember(Number(id));
        }
        setTeam(await collaboration.team());
      },
      () => {
        toast("Agent saved.");
        setDraft(null);
        setOriginalDraft(null);
        setRoleChoice(null);
        setMemberChoices({});
        setDiscardConfirm(false);
      }
    );
  };

  // Creates the agent, then adds the ticked skills; a skills failure never undoes the agent.
  const createFromTemplate = async (input: AgentInput, source: { template: AgentTemplate; skills: string[] }) => {
    setBusy(true);
    setError(null);
    try {
      const agent = await api.createAgent({ ...input, make_lead: isLead });
      const savedDraft = toDraft(agent);
      setDraft(savedDraft);
      setOriginalDraft(savedDraft);
      setFromTemplate(null);
      setRoleChoice({ id: agent.id, value: isLead });
      if (isLead) for (const [id, included] of Object.entries(memberChoices)) {
        if (included) await collaboration.addMember(Number(id));
        else if (team?.agents.some(member => member.id === Number(id))) await collaboration.removeMember(Number(id));
      }
      setTeam(await collaboration.team());
      const chosen = source.template.skills.filter((skill) => source.skills.includes(skill.name));
      const notice = skillInstallNotice(await installTemplateSkills(agent.id, source.template.id, chosen, api.installTemplateSkill));
      setDraft(null);
      setFromTemplate(null);
      toast("Agent saved.");
      onChanged();
      onCreated?.(agent);
      if (notice) setError(notice);
      else onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const addTemplate = (template: AgentTemplate) => {
    const taken = agents.filter((agent) => agent.archived_at === null).map((agent) => agent.name);
    setGallery(false);
    setFromTemplate({ template, skills: template.skills.map((skill) => skill.name) });
    const templateDraft = {
      ...EMPTY,
      name: uniqueAgentName(template.name, taken),
      title: template.role,
      description: template.description,
      instructions: template.instructions,
      starter_notes: template.starter_notes ?? "",
    };
    setDraft(templateDraft);
    setOriginalDraft(EMPTY);
    setEditorSection("basics");
  };

  const openNotes = async (agent: Agent) => {
    setError(null);
    setNotes({ agent, memory: null, text: "", conflict: false, saved: null });
    try {
      const memory = await api.getAgentMemory(agent.id);
      setNotes({ agent, memory, text: memory.text, conflict: false, saved: null });
    } catch (err) {
      setError(errorText(err));
    }
  };

  // `overwrite` saves without the hash check, after a conflict was shown.
  const saveNotes = async (overwrite = false) => {
    if (!notes?.memory) return;
    setBusy(true);
    setError(null);
    try {
      const memory = await api.saveAgentMemory(notes.agent.id, notes.text, overwrite ? null : notes.memory.hash);
      const saved = memory.redacted > 0 ? `Saved. ${memory.redacted} thing(s) that looked like secrets were replaced.` : "Saved.";
      setNotes({ ...notes, memory, text: memory.text, conflict: false, saved });
    } catch (err) {
      if (err instanceof ApiError && err.code === "memory_changed") setNotes({ ...notes, conflict: true, saved: null });
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const loadTheirs = async () => {
    if (!notes) return;
    try {
      const memory = await api.getAgentMemory(notes.agent.id);
      setNotes({ ...notes, memory, text: memory.text, conflict: false, saved: null });
    } catch (err) {
      setError(errorText(err));
    }
  };

  const toggleRecallOn = (agent: Agent, on: boolean) =>
    run(
      () => api.updateAgent(agent.id, { recall_enabled: on }),
      () => setNotes((open) => (open ? { ...open, agent: { ...open.agent, recall_enabled: on } } : open))
    );

  const toggleNotesOn = (agent: Agent, on: boolean) =>
    run(
      () => api.updateAgent(agent.id, { memory_enabled: on }),
      () => setNotes((open) => (open ? { ...open, agent: { ...open.agent, memory_enabled: on } } : open))
    );

  const doExport = async () => {
    if (!exporting) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.exportAgent(exporting.agent.id, exporting.includeNotes);
      saveFile(result.file_name, agentFileText(result.document));
      const left = result.skipped?.length ? ` Left out because the file would be too large: ${result.skipped.join(", ")}.` : "";
      setExporting({
        ...exporting,
        notice: (redactionNotice(result.redacted) ?? "Saved. The file has no model, folder, approval mode or conversations.") + left,
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const pickImport = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const parsed = parseAgentFile(await file.text());
      const agent = parsed.agent as { name?: unknown } | undefined;
      const name = typeof agent?.name === "string" ? agent.name : file.name;
      const hasNotes = agentFileHasNotes(parsed);
      setImporting({ document: parsed, name, hasNotes, includeNotes: hasNotes });
    } catch (err) {
      setError(errorText(err));
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const previewMigration = () => {
    if (!migration?.source || migration.source === "openbot") return;
    setError(null);
    try {
      const preview = parseExternalAgentSetup(migration.text, migration.source);
      setImporting({
        document: preview.document,
        name: preview.name,
        hasNotes: false,
        includeNotes: false,
        migration: preview,
      });
      setMigration(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const copyMigrationPrompt = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      const prompt = migration?.source === "hermes"
        ? HERMES_AGENT_EXPORT_PROMPT
        : migration?.source === "grok"
          ? GROK_AGENT_EXPORT_PROMPT
          : null;
      if (!prompt) throw new Error("Choose an export source first.");
      await navigator.clipboard.writeText(prompt);
      setMigration((current) => current ? { ...current, copied: true } : current);
      setError(null);
    } catch {
      setError("Could not copy the prompt. Select and copy it from the box below.");
    }
  };

  const previewOpenBotDatabase = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setOpenBotDatabase(await api.previewOpenBotDatabase(file));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      if (openBotDatabaseInput.current) openBotDatabaseInput.current.value = "";
    }
  };

  const reviewOpenBotDatabaseProfile = (profile: OpenBotDatabaseProfilePreview) => {
    setImporting({
      document: profile.document,
      name: profile.name,
      hasNotes: false,
      includeNotes: false,
      migration: {
        document: profile.document,
        sourceLabel: "OpenBot database",
        name: profile.name,
        title: profile.title,
        description: "",
        instructions: profile.instructions,
        mappingNotice: "The source agent's description is imported as Open Dots instructions.",
      },
    });
    setOpenBotDatabase(null);
    setMigration(null);
  };

  const visible = agents.filter((agent) => showArchived || agent.archived_at === null);
  const engineLabels = new Map(engines.map((engine) => [engine.id, engine.label]));
  const searchEnabled = shouldShowAgentSearch(visible.length);
  const filteredAgents = filterAgents(visible, searchEnabled ? agentFilter : "", engineLabels);
  const unavailableEngines = unavailableEnginesInUse(visible, engines);
  const initialLead = draft !== null && draft.id !== null && team?.team?.lead_agent_id === draft.id;
  const leadDirty = draft !== null && roleChoice?.id === draft.id && roleChoice.value !== initialLead;
  const membersDirty = draft !== null && isLead && Object.entries(memberChoices).some(([id, included]) => included !== (team?.agents.some((member) => member.id === Number(id)) ?? false));
  const templateSkillsDirty = fromTemplate !== null && (
    fromTemplate.skills.length !== fromTemplate.template.skills.length ||
    fromTemplate.template.skills.some((skill) => !fromTemplate.skills.includes(skill.name))
  );
  const editorDirty = draft !== null && (
    (originalDraft !== null && draftSignature(draft) !== draftSignature(originalDraft)) || leadDirty || membersDirty || templateSkillsDirty
  );
  const availableApprovalModes = approvalModesForProvider(draft?.provider);
  const modeInfo = availableApprovalModes.find((m) => m.value === draft?.approval_mode);
  const canEditConnectedApps = draft !== null && draft.id !== null && supportsConnectedApps(draft.provider);
  const heading = draft
    ? draft.id === null
      ? fromTemplate ? `New agent · ${fromTemplate.template.name}` : "New agent"
      : "Edit agent"
    : gallery
      ? "Templates"
      : notes
      ? `Notes · ${notes.agent.name}`
      : exporting
        ? `Export · ${exporting.agent.name}`
        : migration
          ? "Migrate agent setup"
          : importing
          ? "Import agent"
          : computerOf
            ? `Computer · ${computerOf.name}`
            : skillsOf
              ? `Skills · ${skillsOf.name}`
              : t("sidebar.agents");
  const openDraft = (nextDraft: Draft) => {
    setDraft(nextDraft);
    setOriginalDraft(nextDraft);
    setEditorSection("basics");
    setRoleChoice(null);
    setMemberChoices({});
    setDiscardConfirm(false);
    setCloseAfterDiscard(false);
    setError(null);
  };
  const back = () => {
    setGallery(fromTemplate !== null && draft !== null);
    setFromTemplate(null);
    setDraft(null);
    setOriginalDraft(null);
    setEditorSection("basics");
    setRoleChoice(null);
    setMemberChoices({});
    setNotes(null);
    setExporting(null);
    setImporting(null);
    setMigration(null);
    setOpenBotDatabase(null);
    setComputerOf(null);
    setSkillsOf(null);
    setDeleteConfirm(null);
    setDiscardConfirm(false);
    setCloseAfterDiscard(false);
    setError(null);
  };

  const requestClose = (closeDialog: boolean) => {
    if (draft && editorDirty) {
      setCloseAfterDiscard(closeDialog);
      setDiscardConfirm(true);
      return;
    }
    if (closeDialog) onClose();
    else back();
  };

  const discardAndClose = () => {
    const closeDialog = closeAfterDiscard;
    setDiscardConfirm(false);
    setCloseAfterDiscard(false);
    if (closeDialog) onClose();
    else back();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) requestClose(true); }}
      title={heading}
      size={draft || gallery ? "lg" : "wide"}
      footer={draft ? (
        <AgentEditorFooter
          dirty={editorDirty}
          saving={busy}
          error={error}
          canSave={draft.name.trim() !== "" && editorDirty && !discardConfirm}
          saveLabel="Save"
          cancelLabel={t("common.cancel")}
          onCancel={() => requestClose(false)}
          form="agent-editor-form"
        />
      ) : undefined}
    >
          {error && !draft && (
            <p role="alert" className="mb-3 text-sm text-danger">
              {error}
            </p>
          )}

          {draft ? (
            <form
              id="agent-editor-form"
              className="flex min-h-[min(28rem,calc(85dvh-8rem))] flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              {discardConfirm && (
                <div role="group" aria-labelledby="discard-agent-title" className="mb-3 flex flex-wrap items-center gap-2 rounded-field border border-warning/50 bg-warning/10 p-3 text-sm">
                  <p id="discard-agent-title" className="min-w-0 flex-1 font-medium">Discard unsaved changes?</p>
                  <Button ref={keepEditingRef} type="button" variant="secondary" onClick={() => { setDiscardConfirm(false); setCloseAfterDiscard(false); }}>Keep editing</Button>
                  <Button type="button" variant="danger" onClick={discardAndClose}>Discard changes</Button>
                </div>
              )}
              <Tabs
                value={editorSection}
                onValueChange={(value) => setEditorSection(value as EditorSection)}
                className="flex min-h-0 flex-1 flex-col"
              >
                <TabList label="Agent settings sections">
                  <Tab value="basics">Basics</Tab>
                  <Tab value="model">Model and approvals</Tab>
                  {canEditConnectedApps && <Tab value="apps">Connected apps</Tab>}
                  <Tab value="memory">Memory and notes</Tab>
                </TabList>
                <div className="min-h-0 flex-1 overflow-y-auto pb-4 pt-4">
                  <TabPanel value="basics" className="space-y-3">
                    {draft.id === null && onSetupChat && admin && (
                      <SetupEntryDisclosure agents={agents} engines={engines} onStart={onSetupChat} onCreateLead={() => setRoleChoice({ id: null, value: true })} />
                    )}
                    <label className="block text-xs text-muted">
                      Name
                      <input
                        autoFocus
                        value={draft.name}
                        maxLength={80}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        placeholder="Code reviewer"
                        className={`${FIELD} mt-1`}
                      />
                    </label>
                    <label className="block text-xs text-muted">
                      Title
                      <input
                        value={draft.title}
                        maxLength={200}
                        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                        placeholder="Reviews pull requests before merge"
                        className={`${FIELD} mt-1`}
                      />
                    </label>
                    <label className="block text-xs text-muted">
                      Description
                      <textarea
                        value={draft.description}
                        rows={2}
                        maxLength={4000}
                        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                        placeholder="For you: what this agent is for. Not sent to Claude."
                        className={`${FIELD} mt-1 resize-y`}
                      />
                    </label>
                    <label className="block text-xs text-muted">
                      Instructions
                      <textarea
                        value={draft.instructions}
                        rows={5}
                        onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                        placeholder="How this agent should behave. Added to every conversation it starts."
                        className={`${FIELD} mt-1 resize-y`}
                      />
                    </label>
                    <label className="block text-xs text-muted">
                      Workspace folder
                      <input
                        value={draft.workspace_path}
                        onChange={(e) => setDraft({ ...draft, workspace_path: e.target.value })}
                        placeholder="Leave empty for the agent's own folder"
                        className={`${FIELD} mt-1 font-mono`}
                      />
                    </label>
                    {draft.id === null && fromTemplate && fromTemplate.template.skills.length > 0 && (
                      <TemplateSkillChoices
                        skills={fromTemplate.template.skills}
                        chosen={fromTemplate.skills}
                        disabled={busy}
                        onChange={(skills) => setFromTemplate({ ...fromTemplate, skills })}
                      />
                    )}
                  </TabPanel>

                  <TabPanel value="model" className="space-y-4">
                    <section className="space-y-2">
                      <h3 className="text-sm font-medium text-ink">Model</h3>
                      <EngineModelFields engines={engines} provider={draft.provider} model={draft.model} disabled={busy} hasComputer={agents.some((agent) => agent.id === draft.id && agent.computer != null)} onChange={(provider, model) => setDraft({ ...draft, provider, model, approval_mode: approvalModesForProvider(provider).some((mode) => mode.value === draft.approval_mode) ? draft.approval_mode : "ask" })} />
                      <p className="text-xs text-muted">Engine changes apply to new conversations. Existing conversations keep their engine.</p>
                    </section>

                    {admin && <fieldset className="space-y-2 rounded-field border border-line p-3">
                      <legend className="px-1 text-sm font-medium">{t("agentTeam.teamPermissionsTitle")}</legend>
                      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isLead} disabled={busy || !team || (!roleSupported && !isLead)} onChange={event => setRoleChoice({ id: draft.id, value: event.target.checked })} />{t("agentTeam.leadRole")}</label>
                      <p className="text-xs text-muted">{t("agentTeam.leadRoleDescription")}</p>
                      {!team && <p className="text-xs text-warning">{t("agentTeam.teamPermissionsRetry")}</p>}
                      {!roleSupported && <p className="text-xs text-warning">{t("agentTeam.teamEngineChoice")}</p>}
                      {team?.enabled === false && <p className="text-xs text-warning">{t("agentTeam.teamsDisabled")}</p>}
                      {isLead && <div className="space-y-2"><p className="text-xs font-medium">{t("agentTeam.leadCoordinates")}</p>{agents.filter(agent => !agent.archived_at && agent.id !== draft.id).map(agent => <label key={agent.id} className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={busy} checked={memberChoices[agent.id] ?? team?.agents.some(member => member.id === agent.id) ?? false} onChange={event => setMemberChoices({ ...memberChoices, [agent.id]: event.target.checked })} />{agent.name}</label>)}<p className="text-xs text-muted">{t("agentTeam.memberSelectionSaved")}</p></div>}
                    </fieldset>}

                    <label className="block text-xs text-muted">
                      Fallback engine when limited
                      <Select
                        aria-label="Fallback engine"
                        value={draft.fallback_provider && draft.fallback_provider !== draft.provider ? draft.fallback_provider : ""}
                        disabled={busy}
                        onChange={(e) => setDraft({ ...draft, fallback_provider: e.target.value || null, fallback_model: null })}
                        className={`${FIELD} mt-1`}
                      >
                        <option value="">None</option>
                        {engines.filter((engine) => engine.id !== draft.provider).map((engine) => (
                          <option key={engine.id} value={engine.id}>{engine.label}</option>
                        ))}
                      </Select>
                    </label>
                    {draft.fallback_provider && draft.fallback_provider !== draft.provider && (
                      <label className="block text-xs text-muted">
                        Fallback model
                        <input
                          aria-label="Fallback model"
                          value={draft.fallback_model ?? ""}
                          onChange={(e) => setDraft({ ...draft, fallback_model: e.target.value || null })}
                          placeholder="Engine default"
                          maxLength={200}
                          className={`${FIELD} mt-1`}
                        />
                      </label>
                    )}
                    <p className="text-xs text-muted">{t("agentTeam.fallbackEngineDescription")}</p>
                    <fieldset className="space-y-2 text-xs text-muted">
                      <legend>Approvals</legend>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {availableApprovalModes.map((mode) => (
                          <label
                            key={mode.value}
                            className={`cursor-pointer rounded-md border px-3 py-2 text-sm touch:min-h-11 ${
                              draft.approval_mode === mode.value
                                ? "border-accent bg-inset text-ink"
                                : "border-line"
                            }`}
                          >
                            <input
                              type="radio"
                              name="approval-mode"
                                className="peer sr-only"
                              checked={draft.approval_mode === mode.value}
                              onChange={() => setDraft({ ...draft, approval_mode: mode.value })}
                            />
                              <span className="inline-flex min-h-8 items-center rounded-md peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent touch:min-h-11">{mode.label}</span>
                          </label>
                        ))}
                      </div>
                      {modeInfo && <p>{modeInfo.description}</p>}
                    </fieldset>
                  </TabPanel>

                  {canEditConnectedApps && (
                    <TabPanel value="apps" className="space-y-3">
                      <ConnectedAppsSection
                        appAccounts={appAccounts}
                        connectorScopes={draft.connector_scopes}
                        connectorAccountScopes={draft.connector_account_scopes}
                        busy={busy}
                        onScopesChange={(connector_scopes) => setDraft({ ...draft, connector_scopes })}
                        onAccountScopesChange={(connector_account_scopes) => setDraft({ ...draft, connector_account_scopes })}
                      />
                    </TabPanel>
                  )}

                  <TabPanel value="memory" className="space-y-3">
                    {draft.id === null && (
                      <label className="block text-xs text-muted">
                        Starter notes
                        <textarea
                          value={draft.starter_notes}
                          rows={5}
                          onChange={(e) => setDraft({ ...draft, starter_notes: e.target.value })}
                          placeholder={"- The project uses pnpm\n- Releases go out on Fridays"}
                          className={`${FIELD} mt-1 resize-y font-mono`}
                        />
                        <span className="mt-1 block">{t("agentTeam.firstNotesHelp")}</span>
                      </label>
                    )}
                    <label className="flex cursor-pointer items-center gap-2 rounded-md border border-line p-3 text-sm text-ink touch:min-h-11">
                      <input
                        type="checkbox"
                        checked={draft.memory_enabled}
                        disabled={busy}
                        onChange={() => setDraft({ ...draft, memory_enabled: !draft.memory_enabled })}
                      />
                      Use notes: load this agent&apos;s MEMORY.md into each conversation
                    </label>
                  </TabPanel>
                </div>
              </Tabs>
            </form>
          ) : gallery ? (
            <div className="space-y-3">
              <TemplatesGallery onAdd={addTemplate} />
              <button type="button" onClick={back} className={BUTTON}>
                Back to agents
              </button>
            </div>
          ) : computerOf ? (
            <div className="space-y-3">
              <ComputerView
                agent={computerOf}
                onChanged={onChanged}
                engineSupportsComputers={engines.find((engine) => engine.id === computerOf.provider)?.capabilities.computers}
                engineLabel={engines.find((engine) => engine.id === computerOf.provider)?.label ?? computerOf.provider}
              />
              <button onClick={back} className={BUTTON}>
                Back
              </button>
            </div>
          ) : skillsOf ? (
            <div className="space-y-3">
              <SkillsPanel key={skillsOf.id} agent={skillsOf} />
              <button onClick={back} className={BUTTON}>
                Back
              </button>
            </div>
          ) : notes ? (
            <NotesEditor
              notes={notes}
              busy={busy}
              onText={(text) => setNotes({ ...notes, text, saved: null })}
              onSave={() => saveNotes(false)}
              onOverwrite={() => saveNotes(true)}
              onLoadTheirs={loadTheirs}
              onToggle={(on) => toggleNotesOn(notes.agent, on)}
              onToggleRecall={(on) => toggleRecallOn(notes.agent, on)}
              onAgentChange={(patch) =>
                setNotes((open) => (open ? { ...open, agent: { ...open.agent, ...patch } } : open))
              }
              onReload={loadTheirs}
              onBack={back}
            />
          ) : exporting ? (
            <div className="space-y-3 text-sm">
              <p className="text-muted">
                Saves this agent as one file you can keep or give to someone. It holds the name, title, description and
                instructions. Never its model, folder, approval mode or conversations; an imported copy always starts on
                &quot;Ask first&quot;.
              </p>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={exporting.includeNotes}
                  onChange={() => setExporting({ ...exporting, includeNotes: !exporting.includeNotes, notice: null })}
                />
                Include its notes (MEMORY.md) as starter notes. Leave off if they hold private details.
              </label>
              {exporting.notice && <p className="text-xs text-muted">{exporting.notice}</p>}
              <div className="flex gap-2">
                <button onClick={doExport} disabled={busy} className={PRIMARY}>
                  {busy ? "Saving…" : "Save file"}
                </button>
                <button onClick={back} disabled={busy} className={BUTTON}>
                  Done
                </button>
              </div>
            </div>
          ) : migration ? (
            <div className="space-y-3 text-sm">
              {migration.source === null ? (
                <>
                  <p>Choose how you want to bring in a single agent setup.</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setMigration({ ...migration, source: "grok" })}
                      className={BUTTON}
                    >
                      Grok Bot export
                    </button>
                    <button
                      type="button"
                      onClick={() => setMigration({ ...migration, source: "hermes" })}
                      className={BUTTON}
                    >
                      Hermes Agent export
                    </button>
                    <button
                      type="button"
                      onClick={() => { setOpenBotDatabase(null); setMigration({ ...migration, source: "openbot" }); }}
                      disabled={!canReadOpenBotDatabase}
                      className={BUTTON}
                      title={canReadOpenBotDatabase ? undefined : "Available only when connected to a local backend."}
                    >
                      OpenBot database{canReadOpenBotDatabase ? "" : " · local app only"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setMigration({ ...migration, source: "other" })}
                      className={BUTTON}
                    >
                      Another agent JSON
                    </button>
                  </div>
                  <button type="button" onClick={back} className={BUTTON}>Cancel</button>
                </>
              ) : migration.source === "openbot" ? (
                <>
                  <input
                    ref={openBotDatabaseInput}
                    type="file"
                    accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3"
                    className="hidden"
                    aria-label="Choose OpenBot database"
                    onChange={(event) => previewOpenBotDatabase(event.target.files?.[0])}
                  />
                  <p>
                    Choose the OpenBot <code>openbot.db</code> file. Close OpenBot first so its latest changes are saved.
                    The read-only file can be up to 128 MB and must use a supported schema version.
                  </p>
                  <p className="text-xs text-muted">
                    The file is sent only to the local Open Dots backend for preview and discarded afterward. Only
                    agent names, titles and role text are returned; memories, skills, routines, connections, messages,
                    credentials, tools and other settings are not imported. This option is unavailable on hosted accounts.
                  </p>
                  {!openBotDatabase ? (
                    <button
                      type="button"
                      onClick={() => openBotDatabaseInput.current?.click()}
                      disabled={busy}
                      className={PRIMARY}
                    >
                      {busy ? "Reading…" : "Choose openbot.db"}
                    </button>
                  ) : (
                    <>
                      <p className="text-xs text-muted">
                        Found {openBotDatabase.profiles.length} agent{openBotDatabase.profiles.length === 1 ? "" : "s"}
                        in schema version {openBotDatabase.schema_version}. Choose one to review; import the others one at a time.
                      </p>
                      <div className="max-h-64 space-y-2 overflow-auto rounded-md border border-line p-2">
                        {openBotDatabase.profiles.map((profile) => (
                          <button
                            key={profile.key}
                            type="button"
                            onClick={() => reviewOpenBotDatabaseProfile(profile)}
                            className="block w-full rounded-md px-3 py-2 text-left hover:bg-hover"
                          >
                            <span className="block font-medium">{profile.name}</span>
                            {profile.title && <span className="block text-xs text-muted">{profile.title}</span>}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => { setOpenBotDatabase(null); openBotDatabaseInput.current?.click(); }}
                        disabled={busy}
                        className={BUTTON}
                      >
                        Choose another file
                      </button>
                    </>
                  )}
                  <button type="button" onClick={back} disabled={busy} className={BUTTON}>Cancel</button>
                </>
              ) : (
                <>
                  <p>
                    {migration.source === "grok"
                      ? "Copy the prompt into Grok Bot, then paste its JSON reply below."
                      : migration.source === "hermes"
                        ? "Copy the prompt into Hermes Agent, then paste its JSON reply below."
                        : "Paste one agent's JSON export. We will read common name, title, description and instruction fields."}
                  </p>
                  {migration.source !== "other" ? (
                    <details className="rounded-md border border-line p-3">
                      <summary className="cursor-pointer font-medium">Export prompt</summary>
                      <div className="mt-2 space-y-2">
                        <textarea
                          readOnly
                          aria-label={`${migration.source === "hermes" ? "Hermes Agent" : "Grok Bot"} export prompt`}
                          value={migration.source === "hermes" ? HERMES_AGENT_EXPORT_PROMPT : GROK_AGENT_EXPORT_PROMPT}
                          rows={8}
                          className={`${FIELD} font-mono text-xs`}
                        />
                        <button type="button" onClick={copyMigrationPrompt} className={BUTTON}>
                          {migration.copied ? "Copied" : "Copy prompt"}
                        </button>
                      </div>
                    </details>
                  ) : (
                    <div className="rounded-md border border-line p-3 text-xs text-muted">
                      Expected fields: name, title, description and instructions. Other settings are ignored.
                    </div>
                  )}
                  <label className="block space-y-1">
                    <span className="text-xs font-medium">Paste JSON export</span>
                    <textarea
                      aria-label="Paste agent setup JSON"
                      value={migration.text}
                      onChange={(event) => setMigration({ ...migration, text: event.target.value, copied: false })}
                      rows={9}
                      className={`${FIELD} font-mono text-xs`}
                      placeholder='{"name":"Research assistant","instructions":"..."}'
                    />
                  </label>
                  <p className="text-xs text-muted">
                    Only name, title, description and instructions are imported. Skills, routines, connected apps,
                    credentials, memories, tools, files and chat history are not transferred.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={previewMigration}
                      disabled={!migration.text.trim() || busy}
                      className={PRIMARY}
                    >
                      Review import
                    </button>
                    <button type="button" onClick={back} disabled={busy} className={BUTTON}>Cancel</button>
                  </div>
                </>
              )}
            </div>
          ) : importing ? (
            <div className="space-y-3 text-sm">
              {importing.migration ? (
                <>
                  <div className="rounded-md border border-line p-3">
                    <p className="font-medium">Source: {importing.migration.sourceLabel}</p>
                    {importing.migration.mappingNotice && (
                      <p className="mt-1 text-xs text-muted">{importing.migration.mappingNotice}</p>
                    )}
                    <p className="mt-1 text-xs text-muted">
                      The following fields will be copied to a new agent. It starts on &quot;Ask first&quot; with the
                      default model and its own folder.
                    </p>
                    <dl className="mt-3 space-y-2">
                      <div>
                        <dt className="text-xs font-medium text-muted">Name</dt>
                        <dd className="break-words">{importing.migration.name}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted">Title</dt>
                        <dd className="break-words">{importing.migration.title || "Not provided"}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted">Description</dt>
                        <dd className="max-h-20 overflow-auto whitespace-pre-wrap break-words">
                          {importing.migration.description || "Not provided"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted">Instructions</dt>
                        <dd>
                          <details className="mt-1">
                            <summary className="cursor-pointer">Review full instructions</summary>
                            <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-line p-2 text-xs">
                              {importing.migration.instructions}
                            </div>
                          </details>
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <p className="text-xs text-muted">
                    Skills, routines, connected apps, credentials, memories, tools, files and chat history are not
                    transferred. Configure those separately after reviewing the agent.
                  </p>
                </>
              ) : (
                <p>
                  Add <span className="font-medium">{importing.name}</span> as a new agent. It starts on &quot;Ask first&quot;
                  with the default model and its own folder; a name already in use gets a number.
                </p>
              )}
              {importing.hasNotes && (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={importing.includeNotes}
                    onChange={() => setImporting({ ...importing, includeNotes: !importing.includeNotes })}
                  />
                  Keep the file&apos;s starter notes
                </label>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => run(() => api.importAgent(importing.document, importing.includeNotes), back)}
                  disabled={busy}
                  className={PRIMARY}
                >
                  {busy ? "Adding…" : "Add agent"}
                </button>
                <button onClick={back} disabled={busy} className={BUTTON}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex shrink-0 items-center gap-3">
                  <Button variant="primary" onClick={() => openDraft({ ...EMPTY })}>
                    {t("sidebar.newAgent")}
                  </Button>
                  {onSetupChat && admin && (
                    <SetupEntryDisclosure agents={agents} engines={engines} onStart={onSetupChat} onCreateLead={() => { openDraft({ ...EMPTY }); setRoleChoice({ id: null, value: true }); }} />
                  )}
                </div>
                {searchEnabled && (
                  <label className="min-w-[12rem] flex-1">
                    <span className="sr-only">Search agents</span>
                    <input
                      type="search"
                      aria-label="Search agents"
                      value={agentFilter}
                      onChange={(event) => setAgentFilter(event.target.value)}
                      placeholder="Search agents"
                      className={`${FIELD} h-9 py-1.5`}
                    />
                  </label>
                )}
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Button onClick={() => setGallery(true)}>Templates…</Button>
                  <Button onClick={() => { setError(null); setOpenBotDatabase(null); setMigration({ source: null, text: "", copied: false }); }}>
                    Migrate…
                  </Button>
                  <Button onClick={() => fileInput.current?.click()}>Import…</Button>
                  <label className="flex min-h-9 cursor-pointer items-center gap-2 px-1 text-xs text-muted touch:min-h-11">
                    <input type="checkbox" checked={showArchived} onChange={() => setShowArchived((on) => !on)} />
                    {t("sidebar.showArchived")}
                  </label>
                </div>
              </div>
              {visible.length === 0 ? (
                <p className="text-sm text-muted">
                  No agents yet. An agent keeps its own instructions, model, workspace, approval mode and notes.
                </p>
              ) : filteredAgents.length === 0 ? (
                <p className="text-sm text-muted">No agents match that search.</p>
              ) : (
                <>
                {unavailableEngines.length > 0 && (
                  <div role="status" aria-label="AI connection status" className="mb-2 flex min-w-0 items-center gap-2 rounded-field border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
                    <p className="min-w-0 flex-1 truncate" title={unavailableEngines.map((engine) => `${engine.label}: ${engine.signed_in === false ? "not signed in" : engine.reason ?? "unavailable"}`).join(" · ")}>
                      Connect an AI: {unavailableEngines.map((engine) => `${engine.label} ${engine.signed_in === false ? "is not signed in" : engine.reason ?? "is unavailable"}`).join(" · ")}
                    </p>
                    <Link href="/settings/engines/" className="shrink-0 font-medium underline underline-offset-2">Engine settings</Link>
                  </div>
                )}
                <ul className="space-y-1">
                  {filteredAgents.map((agent) => {
                    const archived = agent.archived_at !== null;
                    const engine = engines.find((candidate) => candidate.id === agent.provider);
                    const description = agent.description?.trim() || (agent.title?.trim() ? "" : agent.instructions?.trim() || "No description yet.");
                    return (
                      <li key={agent.id} className="rounded-card border border-line bg-raised px-2.5 py-1.5">
                        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                          <div className="flex min-w-0 flex-1 items-start gap-3">
                            <Avatar agentId={agent.id} name={agent.name} size="md" />
                            <div className="min-w-0 flex-1 space-y-0">
                              <div className="flex min-w-0 flex-wrap items-center gap-1.5 leading-4">
                                <p className="min-w-0 truncate text-sm font-semibold text-ink">{agent.name}</p>
                                {agent.title?.trim() && <span className="min-w-0 max-w-[12rem] truncate rounded-full border border-line px-1.5 py-0.5 text-[11px] font-medium text-muted" title={agent.title}>{agent.title}</span>}
                                {agent.pinned && <Badge tone="accent">Pinned</Badge>}
                                {archived && <Badge>Archived</Badge>}
                                {engine?.available === false && <span role="img" className="inline-block size-2 shrink-0 rounded-full bg-warning" title={engine.reason ?? `${engine.label} is not available`} aria-label={`${engine.label} is not available`} />}
                              </div>
                              {description && <p className="truncate text-xs leading-4 text-muted" title={description}>{description}</p>}
                              <div className="flex min-w-0 flex-wrap gap-1" role="group" aria-label="Agent configuration">
                                <Badge className="max-w-full truncate !px-1.5 !py-0 text-[10px]">{engine?.label ?? agent.provider}</Badge>
                                <Badge className="max-w-full truncate !px-1.5 !py-0 text-[10px]">{modelLabel(agent.model)}</Badge>
                                <Badge className="max-w-full truncate !px-1.5 !py-0 text-[10px]">{approvalModeLabel(agent.approval_mode)}</Badge>
                              </div>
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-wrap items-center gap-1" role="group" aria-label={`Actions for ${agent.name}`}>
                            <Button size="sm" variant="secondary" onClick={() => openDraft(toDraft(agent))} disabled={busy}>Edit</Button>
                            <Button size="sm" variant="ghost" onClick={() => openNotes(agent)} disabled={busy}>Notes</Button>
                            <Button size="sm" variant="ghost" onClick={() => setSkillsOf(agent)} disabled={busy}>Skills</Button>
                            {!archived && <Button size="sm" variant="ghost" onClick={() => setComputerOf(agent)} disabled={busy}>Computer</Button>}
                            <Menu
                              align="start"
                              trigger={<IconButton label={`More actions for ${agent.name}`} disabled={busy}><Ellipsis size={18} aria-hidden="true" /></IconButton>}
                            >
                              {!archived && <MenuItem onSelect={() => run(() => api.duplicateAgent(agent.id))}>Duplicate</MenuItem>}
                              {!archived && <MenuItem onSelect={() => run(() => api.updateAgent(agent.id, { pinned: !agent.pinned }))}>{agent.pinned ? "Unpin" : "Pin"}</MenuItem>}
                              <MenuItem onSelect={() => setExporting({ agent, includeNotes: false, notice: null })}>Export</MenuItem>
                              <MenuItem onSelect={() => run(() => api.updateAgent(agent.id, { archived: !archived }))}>{archived ? "Restore" : "Archive"}</MenuItem>
                              <MenuSeparator />
                              <MenuItem onSelect={() => setDeleteConfirm(agent)} danger>Delete</MenuItem>
                            </Menu>
                          </div>
                        </div>
                        {deleteConfirm?.id === agent.id && (
                          <div ref={deleteConfirmationRef} role="alert" className="mt-3 rounded-md border border-danger/50 p-3 pb-4 text-xs">
                            <p className="font-medium">Delete {agent.name} permanently?</p>
                            <p className="mt-1 text-muted">
                              This removes the agent, its notes and skills, and its computer. Its conversations stay in history
                              but become unlinked and continue without this agent&apos;s instructions. Its workspace folder stays;
                              routines assigned to it will be safely turned off. This cannot be undone.
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button ref={keepAgentRef} onClick={() => setDeleteConfirm(null)} disabled={busy} className={SMALL}>
                                Keep agent
                              </button>
                              <button
                                onClick={() => run(() => api.deleteAgent(agent.id), () => setDeleteConfirm(null))}
                                disabled={busy}
                                className={`${SMALL} border-danger/50 text-danger`}
                              >
                                {busy ? "Deleting…" : "Delete permanently"}
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                </>
              )}
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                className="hidden"
                aria-label="Agent file to import"
                onChange={(e) => pickImport(e.target.files?.[0])}
              />
            </>
          )}
    </Dialog>
  );
}

function NotesEditor({
  notes,
  busy,
  onText,
  onSave,
  onOverwrite,
  onLoadTheirs,
  onToggle,
  onToggleRecall,
  onAgentChange,
  onReload,
  onBack,
}: {
  notes: NotesState;
  busy: boolean;
  onText: (text: string) => void;
  onSave: () => void;
  onOverwrite: () => void;
  onLoadTheirs: () => void;
  onToggle: (on: boolean) => void;
  onToggleRecall: (on: boolean) => void;
  onAgentChange: (patch: Partial<Agent>) => void;
  onReload: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const { memory } = notes;
  if (!memory) return <p className="text-sm text-muted">Loading notes…</p>;
  const gauge = memoryGauge(memory);
  const dirty = notes.text !== memory.text;
  const enabled = notes.agent.memory_enabled ?? true;
  const recall = notes.agent.recall_enabled ?? true;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Notes this agent keeps between conversations, in <span className="font-mono break-all">{memory.path}</span>. Only
        the first {memory.max_lines} lines load into each conversation. Anything that looks like a password or key is
        replaced when saved.
      </p>
      <div>
        <div className="h-1.5 w-full overflow-hidden rounded bg-hover" aria-hidden="true">
          <div className={`h-full ${GAUGE_COLOR[gauge.level]}`} style={{ width: `${gauge.percent}%` }} />
        </div>
        <p className={`mt-1 text-xs ${gauge.level === "over" ? "text-danger" : "text-muted"}`}>{gauge.text}</p>
      </div>
      <textarea
        value={notes.text}
        rows={12}
        onChange={(e) => onText(e.target.value)}
        aria-label="Notes"
        placeholder={"- Facts this agent should remember\n- One per line"}
        className={`${FIELD} resize-y font-mono`}
      />
      {notes.conflict && (
        <div role="alert" className="rounded-md border border-warning/60 p-3 text-xs">
          <p>{t("agentTeam.agentNotesConflict")}</p>
          <div className="mt-2 flex gap-2">
            <button onClick={onLoadTheirs} disabled={busy} className={SMALL}>
              Load its version
            </button>
            <button onClick={onOverwrite} disabled={busy} className={SMALL}>
              Overwrite with mine
            </button>
          </div>
        </div>
      )}
      {notes.saved && <p className="text-xs text-muted">{notes.saved}</p>}
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={enabled} disabled={busy} onChange={() => onToggle(!enabled)} />
        Use notes in this agent&apos;s conversations
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={recall} disabled={busy || !enabled} onChange={() => onToggleRecall(!recall)} />
        Recall before each message: add matching topic notes and passages from earlier conversations to the message
        (shown as a &ldquo;Recalled&rdquo; chip)
      </label>
      <div className="flex gap-2">
        <button onClick={onSave} disabled={busy || !dirty} className={PRIMARY}>
          {busy ? "Saving…" : "Save notes"}
        </button>
        <button onClick={onBack} disabled={busy} className={BUTTON}>
          {dirty ? "Discard" : "Done"}
        </button>
      </div>
      <MemoryPanel agent={notes.agent} onAgentChange={onAgentChange} onNotesChanged={() => !dirty && onReload()} />
      <SkillsPanel key={notes.agent.id} agent={notes.agent} />
    </div>
  );
}
