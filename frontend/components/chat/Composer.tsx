"use client";

import { ArrowUp, Paperclip, Sparkles, Square, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { isLongPaste, isSendKey, livePastes, removePaste } from "@/lib/composer";
import { loadDraft, saveDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";
import { MAX_SKILLS_PER_MESSAGE, skillCompletions, type SkillSummary } from "@/lib/skills";
import { Button } from "@/components/ui/Button";
import { PendingAttachments } from "./Attachments";

const MAX_HEIGHT_PX = 200;

// The message box: one rounded field with the paperclip on the left and Send (or Stop while an
// answer is being written) on the right. Enter sends, Shift+Enter adds a line, and Enter during
// IME composition does neither. While it cannot send it says why, instead of just going grey.
export function Composer({
  value,
  onChange,
  onSend,
  sending,
  blockedReason,
  blockedAction,
  error,
  running,
  stopping,
  onStop,
  files = [],
  onAddFiles,
  onRemoveFile,
  attachNotice = null,
  focusRequested = false,
  onFocused,
  skills,
  chosenSkills = [],
  onToggleSkill,
  onSaveAsSkill,
  draftKey = null,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  // Why a message cannot be sent right now (a turn is running, the session is
  // broken, ...). Null when it can.
  blockedReason: string | null;
  // A way to clear the block, such as signing the engine in (shown while the box is blocked).
  blockedAction?: { label: string; onClick: () => void } | null;
  error: string | null;
  // An answer is being written: the button becomes Stop.
  running: boolean;
  // Stop was pressed and the answer has not ended yet.
  stopping: boolean;
  onStop: () => void;
  // Files chosen for the next message (docs/EVERYDAY.md). Without onAddFiles
  // the composer offers no attachments.
  files?: File[];
  onAddFiles?: (files: File[]) => void;
  onRemoveFile?: (index: number) => void;
  // Why an attachment was refused or cannot be sent, if anything.
  attachNotice?: string | null;
  // New chat asks for the box to take focus; onFocused clears the request.
  focusRequested?: boolean;
  onFocused?: () => void;
  // The agent's skills. With onToggleSkill the box offers a picker and `/name` completion;
  // chosen ones are sent with the next message only. A skill never starts on its own.
  skills?: SkillSummary[];
  chosenSkills?: string[];
  onToggleSkill?: (name: string) => void;
  // Opens the skill editor seeded from this conversation. Sends and saves nothing.
  onSaveAsSkill?: () => void;
  // Identifies the conversation (its id, or "new"). With it the unsent text is kept per
  // conversation and put back when you return. Without it nothing is stored.
  draftKey?: string | null;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const menuId = useId();
  // Long pasted blocks show as a chip; the text stays in the box so Send still includes it.
  const [pasted, setPasted] = useState<{ key: string | null; list: string[] }>({ key: draftKey, list: [] });
  const chips = pasted.key === draftKey ? livePastes(value, pasted.list) : [];
  const setPastes = (update: (all: string[]) => string[]) => setPasted({ key: draftKey, list: update(pasted.key === draftKey ? pasted.list : []) });
  // Drafts: put the saved text back when the conversation changes, then keep saving edits.
  // `restored` stops the old text being written under the new key before it is swapped.
  const restored = useRef<string | null>(null);
  useEffect(() => {
    restored.current = draftKey;
    const saved = loadDraft(draftKey);
    if (draftKey && saved) onChange(saved);
    // Only a change of conversation restores; later edits flow through `value`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
  useEffect(() => {
    if (draftKey && restored.current === draftKey) saveDraft(draftKey, value);
  }, [draftKey, value]);
  const [menu, setMenu] = useState({ context: "", index: 0, dismissed: false });
  const enabledSkills = (skills ?? []).filter((s) => s.enabled);
  const completions = onToggleSkill ? skillCompletions(value, enabledSkills, chosenSkills) : [];
  // A changed query or available list starts at the first result, even after Escape.
  const menuContext = JSON.stringify([value, completions.map((s) => s.name)]);
  const activeIndex = menu.context === menuContext ? Math.min(menu.index, Math.max(0, completions.length - 1)) : 0;
  const slashOpen = focused && !sending && !pickerOpen && !!onToggleSkill && /^\/[a-z0-9-]*$/.test(value)
    && !(menu.context === menuContext && menu.dismissed);
  const activeOption = slashOpen && completions.length > 0 ? `${menuId}-${activeIndex}` : undefined;
  const dismissMenu = () => setMenu({ context: menuContext, index: activeIndex, dismissed: true });
  const pick = (name: string) => {
    if (sending || (!chosenSkills.includes(name) && chosenSkills.length >= MAX_SKILLS_PER_MESSAGE)) return;
    onToggleSkill?.(name);
    onChange("");
    box.current?.focus();
  };

  useEffect(() => {
    if (!focusRequested) return;
    box.current?.focus();
    onFocused?.();
  }, [focusRequested, onFocused]);

  // Grows with the text up to a limit.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const canSend = !sending && blockedReason === null && value.trim() !== "";
  const carriesFiles = (types: readonly string[]) => types.includes("Files");

  return (
    <div
      className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-6"
      onDragOver={(e) => {
        if (!onAddFiles || !carriesFiles(Array.from(e.dataTransfer.types))) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!onAddFiles || !carriesFiles(Array.from(e.dataTransfer.types))) return;
        e.preventDefault();
        setDragging(false);
        onAddFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="mx-auto max-w-3xl">
        {error && <p role="alert" className="mb-2 text-sm text-danger">{error}</p>}
        {attachNotice && <p role="status" className="mb-2 text-sm text-warning">{attachNotice}</p>}
        <div
          className={cn(
            "rounded-3xl border bg-raised px-2 py-2 shadow-sm transition-colors duration-(--dur-fast) focus-within:border-accent/60",
            dragging ? "border-accent bg-accent/10" : "border-line",
          )}
        >
          {onRemoveFile && files.length > 0 && (
            <div className="px-2 pt-1"><PendingAttachments files={files} onRemove={onRemoveFile} disabled={sending} /></div>
          )}
          {chips.length > 0 && (
            <ul aria-label="Pasted text" className="flex flex-wrap gap-1.5 px-2 pt-1">
              {chips.map((text, i) => (
                <li key={`${i}-${text.length}`} className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-inset py-0.5 pl-2.5 pr-1 text-xs text-ink">
                  <span className="truncate" title={text.slice(0, 200)}>{t("composer.pasted", { count: text.length.toLocaleString() })}</span>
                  <button type="button" disabled={sending} onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(removePaste(value, text)); setPastes((all) => all.filter((p) => p !== text)); }} aria-label={t("composer.removePasted")} className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-hover hover:text-ink touch:size-8">
                    <X size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {chosenSkills.length > 0 && onToggleSkill && (
            <ul aria-label="Skills for this message" className="flex flex-wrap gap-1.5 px-2 pt-1">
              {chosenSkills.map((name) => (
                <li key={name} className="inline-flex max-w-full items-center gap-1 rounded-full border border-accent/40 bg-accent/10 py-0.5 pl-2.5 pr-1 text-xs text-ink">
                  <Sparkles size={12} aria-hidden="true" className="shrink-0 text-accent" />
                  <span className="truncate font-mono">{name}</span>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onToggleSkill(name)} aria-label={`Remove skill ${name}`} className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-hover hover:text-ink">
                    <X size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {slashOpen && completions.length > 0 && (
            <ul id={menuId} role="listbox" aria-label="Skills" className="mx-2 mt-1 max-h-48 overflow-y-auto rounded-field border border-line bg-raised text-sm">
              {completions.map((s, i) => (
                <li key={s.name} role="presentation">
                  <button id={`${menuId}-${i}`} type="button" role="option" aria-selected={i === activeIndex}
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setMenu({ context: menuContext, index: i, dismissed: false })}
                    onClick={() => pick(s.name)}
                    className={cn("flex w-full min-w-0 cursor-pointer flex-col px-3 py-1.5 text-left hover:bg-hover", i === activeIndex && "bg-hover")}>
                    <span className="font-mono text-xs">/{s.name}</span>
                    <span className="truncate text-xs text-muted">{s.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {slashOpen && completions.length === 0 && (
            <p role="status" className="px-3 py-2 text-xs text-muted">
              {chosenSkills.length >= MAX_SKILLS_PER_MESSAGE
                ? `Up to ${MAX_SKILLS_PER_MESSAGE} skills per message. Remove one to choose another.`
                : enabledSkills.length === 0
                  ? "No skills are switched on for this agent. Add one in the agent's settings."
                  : "No matching skills available. Try another name or open the skill picker."}
            </p>
          )}
          {pickerOpen && onToggleSkill && (
            <div role="group" aria-label="Pick skills" className="mx-2 mt-1 max-h-48 overflow-y-auto rounded-field border border-line bg-raised text-sm">
              {enabledSkills.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted">No skills are switched on for this agent. Add one in the agent&apos;s settings.</p>
              ) : (
                enabledSkills.map((s) => {
                  const on = chosenSkills.includes(s.name);
                  const full = !on && chosenSkills.length >= MAX_SKILLS_PER_MESSAGE;
                  return (
                    <label key={s.name} className={cn("flex min-w-0 items-start gap-2 px-3 py-1.5", full ? "opacity-50" : "cursor-pointer hover:bg-hover")}>
                      <input type="checkbox" className="mt-1" checked={on} disabled={full} onChange={() => onToggleSkill(s.name)} />
                      <span className="min-w-0">
                        <span className="block font-mono text-xs">/{s.name}</span>
                        <span className="block truncate text-xs text-muted">{s.description}</span>
                      </span>
                    </label>
                  );
                })
              )}
              {enabledSkills.length > 0 && <p className="px-3 py-1 text-xs text-faint">Up to {MAX_SKILLS_PER_MESSAGE} per message, used for the next message only.</p>}
            </div>
          )}
          {dragging && <p className="px-3 pb-1 text-xs text-accent">Drop to attach</p>}
          <div className="flex items-end gap-1">
            {onAddFiles && (
              <>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  aria-hidden
                  tabIndex={-1}
                  accept=".wav,.mp3,.m4a,.ogg,.flac,.webm,image/png,image/jpeg,image/gif,image/webp,.txt,.md,.csv,.tsv,.json,.log,.yaml,.yml,.xml,.html,.css,.js,.ts,.tsx,.py,.sh,.sql,.toml,.ini"
                  onChange={(e) => {
                    onAddFiles(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => picker.current?.click()}
                  disabled={sending}
                  aria-label="Attach files"
                  title="Attach images, text or audio files (or paste, or drop them here)"
                  className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted transition-colors duration-(--dur-fast) hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 touch:size-11"
                >
                  <Paperclip size={18} aria-hidden="true" />
                </button>
              </>
            )}
            {onToggleSkill && (
              <button
                type="button"
                onClick={() => { dismissMenu(); setPickerOpen((open) => !open); }}
                disabled={sending}
                aria-label="Pick skills"
                aria-expanded={pickerOpen}
                title="Use a saved skill for this message (or type / and a name)"
                className={cn("inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted transition-colors duration-(--dur-fast) hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 touch:size-11", (pickerOpen || chosenSkills.length > 0) && "text-accent")}
              >
                <Sparkles size={18} aria-hidden="true" />
              </button>
            )}
            <textarea
              ref={box}
              value={value}
              onChange={(e) => {
                setMenu({ context: "", index: 0, dismissed: false });
                onChange(e.target.value);
              }}
              onFocus={() => {
                setFocused(true);
                setMenu({ context: "", index: 0, dismissed: false });
              }}
              onBlur={() => { setFocused(false); dismissMenu(); }}
              aria-autocomplete={onToggleSkill ? "list" : undefined}
              aria-haspopup={onToggleSkill ? "listbox" : undefined}
              aria-controls={activeOption ? menuId : undefined}
              aria-activedescendant={activeOption}
              onPaste={(e) => {
                const pasted = Array.from(e.clipboardData.files);
                if (pasted.length === 0) {
                  const text = e.clipboardData.getData("text");
                  if (isLongPaste(text) && !sending) {
                    e.preventDefault();
                    const el = e.currentTarget;
                    const at = el.selectionStart;
                    onChange(value.slice(0, at) + text + value.slice(el.selectionEnd));
                    setPastes((all) => [...all, text]);
                  }
                  return;
                }
                if (!onAddFiles) return;
                e.preventDefault();
                onAddFiles(pasted);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                if (slashOpen && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && completions.length > 0) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const index = (activeIndex + (e.key === "ArrowDown" ? 1 : -1) + completions.length) % completions.length;
                    setMenu({ context: menuContext, index, dismissed: false });
                    document.getElementById(`${menuId}-${index}`)?.scrollIntoView({ block: "nearest" });
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    pick(completions[activeIndex].name);
                    return;
                  }
                }
                if (e.key === "Escape" && (slashOpen || pickerOpen)) {
                  e.preventDefault();
                  e.stopPropagation();
                  dismissMenu();
                  setPickerOpen(false);
                  return;
                }
                if (isSendKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode })) {
                  e.preventDefault();
                  if (canSend) onSend();
                }
              }}
              rows={1}
              placeholder={blockedReason ?? "Message your agent"}
              aria-label="Message"
              className="max-h-52 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2 py-2.5 text-[15px] leading-5 outline-none placeholder:text-faint focus-visible:outline-none"
            />
            {running ? (
              <button
                type="button"
                onClick={onStop}
                disabled={stopping}
                className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-raised px-4 text-sm font-medium text-ink transition-colors duration-(--dur-fast) hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50 touch:h-11"
              >
                <Square size={13} aria-hidden="true" />
                {stopping ? "Stopping…" : "Stop"}
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-medium text-accent-fg transition-opacity duration-(--dur-fast) hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 touch:h-11"
              >
                <ArrowUp size={16} aria-hidden="true" />
                {sending ? "Sending…" : "Send"}
              </button>
            )}
          </div>
        </div>
        {onSaveAsSkill && (
          <div className="mt-1 flex justify-end px-3">
            <button type="button" onClick={onSaveAsSkill} className="cursor-pointer text-xs text-muted underline-offset-2 hover:text-ink hover:underline">
              Save as skill
            </button>
          </div>
        )}
        {blockedAction && blockedReason && (
          <div className="mt-2 px-3">
            <Button variant="primary" size="sm" onClick={blockedAction.onClick}>{blockedAction.label}</Button>
          </div>
        )}
        {blockedReason && value.trim() !== "" && <p className="mt-1.5 px-3 text-xs text-muted">{blockedReason}</p>}
      </div>
    </div>
  );
}
