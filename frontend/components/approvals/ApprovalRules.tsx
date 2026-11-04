"use client";

import { Select } from "@/components/ui/Select";

import { useEffect, useState } from "react";
import { api, ApiError, type ApprovalRule, type RulePreview } from "@/lib/api";
import { previewView } from "@/lib/approvals";
import { ruleMatchLabel, ruleScopeLabel } from "@/lib/approvals";
import { BUTTON, FIELD, FIELD_BOX } from "./styles";
import { SaveBar } from "@/components/settings/SaveBar";
import { SavedConfirmation, useSavedConfirmation } from "@/components/settings/SavedConfirmation";
import { useT } from "@/lib/use-i18n";

// The saved "always allow" rules for shell commands: list, add and remove.
// With a `workspace`, it starts on the rules that apply in that folder.
export function ApprovalRules({
  workspace = null,
  threadId = null,
}: {
  workspace?: string | null;
  threadId?: number | null;
}) {
  const t = useT();
  const [rules, setRules] = useState<ApprovalRule[] | null>(null);
  const [onlyHere, setOnlyHere] = useState(workspace !== null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [match, setMatch] = useState<"exact" | "prefix">("exact");
  const [command, setCommand] = useState("");
  const [folder, setFolder] = useState(workspace ?? "");
  const [formBaseline, setFormBaseline] = useState<{ match: "exact" | "prefix"; folder: string }>({ match: "exact", folder: workspace ?? "" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const confirmation = useSavedConfirmation();
  const [preview, setPreview] = useState<{ key: string; value: RulePreview | null; error: string | null } | null>(null);

  // Preview the candidate rule before save is possible: the owner sees what it
  // would also allow, straight from the endpoint (never derived locally).
  useEffect(() => {
    const candidate = command.trim();
    if (!candidate) return;
    let cancelled = false;
    const key = `${match}\u0000${candidate}\u0000${folder.trim()}`;
    const timer = setTimeout(() => {
      api
        .previewApprovalRule({ match, command: candidate, workspace: folder.trim() || null })
        .then((p) => { if (!cancelled) setPreview({ key, value: p, error: null }); })
        .catch((err: unknown) => {
          if (!cancelled) setPreview({ key, value: null, error: err instanceof ApiError ? err.message : "Could not preview this rule." });
        });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [match, command, folder]);
  const previewKey = `${match}\u0000${command.trim()}\u0000${folder.trim()}`;
  const activePreview = preview?.key === previewKey ? preview : null;
  const previewable = previewView(activePreview?.value ?? null, { error: activePreview?.error ?? null });

  useEffect(() => {
    let cancelled = false;
    api
      .listApprovalRules(onlyHere ? workspace : null)
      .then((list) => {
        if (!cancelled) {
          setRules(list);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : t("approvals.loadError"));
      });
    return () => {
      cancelled = true;
    };
  }, [onlyHere, workspace, tick, t]);

  const run = async (action: () => Promise<unknown>, then?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      then?.();
      confirmation.showSaved("rules");
      setTick((n) => n + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.operationError"));
    } finally {
      setBusy(false);
    }
  };

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaveError(null);
    void api.addApprovalRule({ match, command: command.trim(), workspace: folder.trim() || null })
      .then(() => {
        setCommand("");
        setFormBaseline({ match, folder });
        confirmation.showSaved("rules");
        setTick((n) => n + 1);
      })
      .catch((err: unknown) => setSaveError(err instanceof ApiError ? err.message : t("common.operationError")))
      .finally(() => setBusy(false));
  };
  const dirty = command.trim() !== "" || match !== formBaseline.match || folder !== formBaseline.folder;
  const discard = () => {
    setCommand("");
    setMatch(formBaseline.match);
    setFolder(formBaseline.folder);
    setSaveError(null);
    confirmation.clearSaved("rules");
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-muted">{t("approvals.explanation")}</p>
      {workspace !== null && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={onlyHere} onChange={(e) => setOnlyHere(e.target.checked)} />
          {t("approvals.onlyThisFolder")}
        </label>
      )}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {rules === null && !error && <p className="text-xs text-muted">{t("approvals.loading")}</p>}
      {rules !== null && rules.length === 0 && (
        <p className="rounded-md bg-inset px-3 py-3 text-xs text-muted">{onlyHere ? t("approvals.emptyFolder") : t("approvals.empty")}</p>
      )}
      {rules !== null && rules.length > 0 && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {rules.map((rule) => (
            <li key={rule.id} className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="break-all font-mono text-xs">{rule.command}</p>
                <p className="mt-0.5 break-all text-xs text-muted">
                  {ruleMatchLabel(rule)} · {ruleScopeLabel(rule)}
                </p>
              </div>
              <button
                className={BUTTON}
                disabled={busy}
                aria-label={t("approvals.removeRule", { command: rule.command })}
                onClick={() => run(() => api.deleteApprovalRule(rule.id, threadId))}
              >
                {t("approvals.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form id="approval-add-form" onSubmit={add} className="space-y-2 rounded-md border border-line p-3">
        <p className="text-xs font-medium">{t("approvals.addRule")}</p>
        <div className="flex gap-2">
          <Select
            aria-label={t("approvals.matchLabel")}
            value={match}
            onChange={(e) => { setMatch(e.target.value === "prefix" ? "prefix" : "exact"); setSaveError(null); confirmation.clearSaved("rules"); }}
            className={`${FIELD_BOX} w-36 shrink-0`}
          >
            <option value="exact">{t("approvals.exactly")}</option>
            <option value="prefix">{t("approvals.startsWith")}</option>
          </Select>
          <input
            aria-label={t("approvals.command")}
            className={`${FIELD} font-mono`}
            placeholder={match === "prefix" ? "git status" : "npm test"}
            value={command}
            onChange={(e) => { setCommand(e.target.value); setSaveError(null); confirmation.clearSaved("rules"); }}
            maxLength={1000}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <input
          aria-label={t("approvals.folder")}
          className={`${FIELD} font-mono`}
          placeholder={t("approvals.folderPlaceholder")}
          value={folder}
          onChange={(e) => { setFolder(e.target.value); setSaveError(null); confirmation.clearSaved("rules"); }}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="space-y-1 rounded-md bg-inset px-3 py-2">
          <p className="text-xs font-medium text-muted">{previewable.floorLabel}</p>
          {previewable.wouldAllow.length > 0 && (
            <div>
              <p className="text-xs text-muted">This rule would also allow:</p>
              <ul className="mt-0.5 space-y-0.5">
                {previewable.wouldAllow.map((c) => (
                  <li key={c} className="break-all font-mono text-xs text-ink">{c}</li>
                ))}
              </ul>
            </div>
          )}
          {command.trim() && activePreview && previewable.wouldAllow.length === 0 && !activePreview.error && (
            <p className="text-xs text-muted">This rule would not allow any known dangerous command.</p>
          )}
        </div>
        <SaveBar
          dirty={dirty}
          saving={busy}
          error={saveError}
          saved={false}
          canSave={Boolean(command.trim()) && previewable.canSave}
          saveLabel={t("approvals.addRule")}
          onSave={() => {
            const form = document.getElementById("approval-add-form");
            if (form instanceof HTMLFormElement) form.requestSubmit();
          }}
          onDiscard={discard}
        />
      </form>
      <SavedConfirmation visible={confirmation.saved.has("rules")} />
    </div>
  );
}
