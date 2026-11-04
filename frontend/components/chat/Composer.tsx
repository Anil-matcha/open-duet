"use client";

import { ArrowUp, Check, FileText, Image as ImageIcon, Loader2, Mic, Music, Plus, Sparkles, Square, Video as VideoIcon, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { isLongPaste, isSendKey, livePastes, removePaste } from "@/lib/composer";
import { loadDraft, saveDraft } from "@/lib/drafts";
import { useT } from "@/lib/use-i18n";
import { MAX_SKILLS_PER_MESSAGE, skillCompletions, type SkillSummary } from "@/lib/skills";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { PendingAttachments } from "./Attachments";

const MAX_HEIGHT_PX = 200;

const UPLOAD_CATEGORIES = [
  {
    id: "documents",
    label: "Document",
    icon: FileText,
    accept: ".pdf,.docx,.doc,.xlsx,.xls,.pptx,.txt,.md,.csv,.tsv,.json,.log,.yaml,.yml,.xml,.html,.css,.js,.ts,.tsx,.py,.sh,.sql,.toml,.ini,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/msword,application/vnd.ms-excel",
  },
  {
    id: "images",
    label: "Image",
    icon: ImageIcon,
    accept: "image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp",
  },
  {
    id: "videos",
    label: "Video",
    icon: VideoIcon,
    accept: "video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.mkv",
  },
  {
    id: "audio",
    label: "Audio",
    icon: Music,
    accept: "audio/*,.wav,.mp3,.m4a,.ogg,.flac,.webm",
  },
];

// The message box: full-width text area with chips on top and action bar (paperclip, skills, Send/Stop) on the bottom.
// Enter sends, Shift+Enter adds a line, and Enter during IME composition does neither.
export function Composer({
  value,
  onChange,
  onSend,
  sending,
  blockedReason,
  blockedAction,
  error,
  running,
  workingMode = null,
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
  // While running, text is steered into the live turn or queued for the next one.
  workingMode?: "steer" | "queue" | null;
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
  const t = useT();
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  const [focused, setFocused] = useState(false);
  const menuId = useId();
  // Long pasted blocks show as a chip; the text stays in the box so Send still includes it.
  const [pasted, setPasted] = useState<{ key: string | null; list: string[] }>({ key: draftKey, list: [] });
  const latestValue = useRef(value);
  useEffect(() => { latestValue.current = value; }, [value]);
  const [dictationError, setDictationError] = useState<string | null>(null);
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
  const slashOpen = focused && !sending && !running && !pickerOpen && !!onToggleSkill && /^\/[a-z0-9-]*$/.test(value)
    && !(menu.context === menuContext && menu.dismissed);
  const activeOption = slashOpen && completions.length > 0 ? `${menuId}-${activeIndex}` : undefined;
  const dismissMenu = () => setMenu({ context: menuContext, index: activeIndex, dismissed: true });
  const pick = (name: string) => {
    if (sending || running || (!chosenSkills.includes(name) && chosenSkills.length >= MAX_SKILLS_PER_MESSAGE)) return;
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

  useEffect(() => {
    if (!attachMenuOpen) return;
    function onPointerDown(e: MouseEvent | TouchEvent) {
      if (
        attachMenuRef.current &&
        !attachMenuRef.current.contains(e.target as Node) &&
        attachButtonRef.current &&
        !attachButtonRef.current.contains(e.target as Node)
      ) {
        setAttachMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAttachMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [attachMenuOpen]);

  const triggerUploadCategory = (acceptPattern: string) => {
    if (!picker.current) return;
    picker.current.accept = acceptPattern;
    picker.current.click();
    setAttachMenuOpen(false);
  };

  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const startRecording = async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mimeType = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const chunks = audioChunksRef.current;
        if (chunks.length === 0) {
          setRecording(false);
          setTranscribing(false);
          return;
        }
        const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
        if (blob.size === 0) {
          setRecording(false);
          setTranscribing(false);
          return;
        }

        setTranscribing(true);
        setDictationError(null);
        try {
          const res = await api.dictateAudio(blob, "recording.webm");
          const text = res.text?.trim();
          if (text) {
            const current = latestValue.current;
            onChange(current.trim() ? `${current.trim()} ${text}` : text);
          }
        } catch (err) {
          console.error("Dictation failed:", err);
          setDictationError("Voice dictation is unavailable right now.");
        } finally {
          setTranscribing(false);
          setRecording(false);
          box.current?.focus();
        }
      };

      recorder.start(250);
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = window.setInterval(() => {
        setRecordSeconds((sec) => sec + 1);
      }, 1000);
    } catch (err) {
      console.error("Failed to access microphone:", err);
      setRecording(false);
    }
  };

  const stopRecording = () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  };

  const cancelRecording = () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    audioChunksRef.current = [];
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.ondataavailable = null;
        mediaRecorderRef.current.onstop = () => {
          mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());
        };
        mediaRecorderRef.current.stop();
      }
    }
    setRecording(false);
    setTranscribing(false);
    setRecordSeconds(0);
  };

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
            "flex flex-col rounded-2xl border bg-raised p-2 shadow-sm transition-colors duration-(--dur-fast) focus-within:border-accent/60",
            dragging ? "border-accent bg-accent/10" : "border-line",
          )}
        >
          {onRemoveFile && files.length > 0 && (
            <div className="px-2 pt-1 pb-1">
              <PendingAttachments files={files} onRemove={onRemoveFile} disabled={sending} />
            </div>
          )}
          {chips.length > 0 && (
            <ul aria-label={t("composer.pastedList")} className="flex flex-wrap gap-1.5 px-2 pt-1 pb-1">
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
            <ul aria-label={t("composer.skillsForMessage")} className="flex flex-wrap gap-1.5 px-2 pt-1 pb-1">
              {chosenSkills.map((name) => (
                <li key={name} className="inline-flex max-w-full items-center gap-1 rounded-full border border-accent/40 bg-accent/10 py-0.5 pl-2.5 pr-1 text-xs text-ink">
                  <Sparkles size={12} aria-hidden="true" className="shrink-0 text-accent" />
                  <span className="truncate font-mono">{name}</span>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onToggleSkill(name)} aria-label={t("composer.removeSkill", { name })} className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-hover hover:text-ink">
                    <X size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {slashOpen && completions.length > 0 && (
            <ul id={menuId} role="listbox" aria-label={t("composer.skills")} className="mx-2 mb-2 max-h-48 overflow-y-auto rounded-field border border-line bg-raised text-sm shadow-md">
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
                ? t("composer.skillsLimitReached", { max: MAX_SKILLS_PER_MESSAGE })
                : enabledSkills.length === 0
                  ? t("composer.noEnabledSkills")
                  : t("composer.noMatchingSkills")}
            </p>
          )}
          {pickerOpen && onToggleSkill && (
            <div role="group" aria-label={t("composer.pickSkillsButton")} className="mx-2 mb-2 max-h-48 overflow-y-auto rounded-field border border-line bg-raised text-sm shadow-md">
              {enabledSkills.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted">{t("composer.noEnabledSkills")}</p>
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
              {enabledSkills.length > 0 && <p className="px-3 py-1 text-xs text-faint">{t("composer.skillsLimit", { max: MAX_SKILLS_PER_MESSAGE })}</p>}
            </div>
          )}
          {dragging && <p className="px-3 pb-1 text-xs text-accent">{t("composer.dropAttach")}</p>}

          {/* Full-width textarea */}
          <div className="relative w-full">
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
                if (!running) onAddFiles(pasted);
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
                if (e.key === "Escape" && (slashOpen || pickerOpen || attachMenuOpen)) {
                  e.preventDefault();
                  e.stopPropagation();
                  dismissMenu();
                  setPickerOpen(false);
                  setAttachMenuOpen(false);
                  return;
                }
                if (isSendKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode })) {
                  e.preventDefault();
                  if (canSend) onSend();
                }
              }}
              rows={1}
              placeholder={blockedReason ?? (workingMode === "steer" ? t("composer.steerPlaceholder") : workingMode === "queue" ? t("composer.queuePlaceholder") : t("composer.placeholder"))}
              aria-label={t("composer.label")}
              className="block w-full max-h-52 min-h-11 resize-none bg-transparent px-2.5 pt-1.5 pb-1 text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint focus-visible:outline-none"
            />
          </div>

          {/* Action Toolbar */}
          <div className="flex items-center justify-between gap-2 px-1 pt-1">
            <div className="flex items-center gap-1">
              {onAddFiles && (
                <div className="relative">
                  <input
                    ref={picker}
                    type="file"
                    multiple
                    hidden
                    aria-hidden
                    tabIndex={-1}
                    accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.wav,.mp3,.m4a,.ogg,.flac,.webm,image/png,image/jpeg,image/gif,image/webp,.mp4,.mov,.txt,.md,.csv,.tsv,.json,.log,.yaml,.yml,.xml,.html,.css,.js,.ts,.tsx,.py,.sh,.sql,.toml,.ini"
                    onChange={(e) => {
                      onAddFiles(Array.from(e.target.files ?? []));
                      e.target.value = "";
                    }}
                  />
                  <Tooltip content={attachMenuOpen ? "Close menu" : t("composer.attach")}>
                    <button
                      ref={attachButtonRef}
                      type="button"
                      onClick={() => {
                        dismissMenu();
                        setPickerOpen(false);
                        setAttachMenuOpen((open) => !open);
                      }}
                      disabled={sending || running}
                      aria-label={t("composer.attachButton")}
                      aria-haspopup="menu"
                      aria-expanded={attachMenuOpen}
                      className={cn(
                        "inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted transition-all duration-(--dur-base) hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 touch:size-10",
                        attachMenuOpen && "bg-hover text-ink shadow-xs"
                      )}
                    >
                      <Plus
                        size={19}
                        className={cn(
                          "transition-transform duration-(--dur-base) ease-[var(--ease-ui)]",
                          attachMenuOpen && "rotate-45 text-accent"
                        )}
                        aria-hidden="true"
                      />
                    </button>
                  </Tooltip>

                  {/* Smooth Animated Minimal Upload Category Menu */}
                  <div
                    ref={attachMenuRef}
                    role="menu"
                    aria-label="Upload options"
                    className={cn(
                      "absolute bottom-full left-0 mb-2 w-40 origin-bottom-left rounded-xl border border-line bg-raised/95 p-1 shadow-lg backdrop-blur-md transition-all duration-(--dur-base) ease-[var(--ease-ui)] z-50",
                      attachMenuOpen
                        ? "opacity-100 scale-100 translate-y-0 pointer-events-auto"
                        : "opacity-0 scale-95 translate-y-1 pointer-events-none"
                    )}
                  >
                    <div className="flex flex-col gap-0.5">
                      {UPLOAD_CATEGORIES.map((cat) => {
                        const Icon = cat.icon;
                        return (
                          <button
                            key={cat.id}
                            type="button"
                            role="menuitem"
                            onClick={() => triggerUploadCategory(cat.accept)}
                            className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-ink transition-colors duration-(--dur-fast) hover:bg-hover hover:text-accent cursor-pointer"
                          >
                            <Icon size={15} className="shrink-0 text-muted transition-colors group-hover:text-accent" aria-hidden="true" />
                            <span>{cat.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
              {onToggleSkill && (
                <Tooltip content={t("composer.pickSkills")}>
                  <button
                    type="button"
                    onClick={() => {
                      dismissMenu();
                      setAttachMenuOpen(false);
                      setPickerOpen((open) => !open);
                    }}
                    disabled={sending || running}
                    aria-label={t("composer.pickSkillsButton")}
                    aria-expanded={pickerOpen}
                    className={cn(
                      "inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted transition-colors duration-(--dur-fast) hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 touch:size-10",
                      (pickerOpen || chosenSkills.length > 0) && "text-accent bg-accent/10"
                    )}
                  >
                    <Sparkles size={18} aria-hidden="true" />
                  </button>
                </Tooltip>
              )}
            </div>

            <div className="flex items-center gap-2">
              {recording ? (
                <div className="flex items-center gap-2 rounded-full border border-danger/40 bg-danger/10 px-3 py-1 text-xs font-medium text-danger animate-pulse">
                  <span className="size-2 rounded-full bg-danger animate-ping" />
                  <span>
                    {Math.floor(recordSeconds / 60)}:{String(recordSeconds % 60).padStart(2, "0")}
                  </span>
                  <button
                    type="button"
                    onClick={stopRecording}
                    className="ml-1 inline-flex size-5 items-center justify-center rounded-full bg-danger text-white hover:opacity-90 cursor-pointer"
                    title="Finish and transcribe"
                    aria-label="Finish and transcribe"
                  >
                    <Check size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={cancelRecording}
                    className="inline-flex size-5 items-center justify-center rounded-full bg-danger/20 text-danger hover:bg-danger/30 cursor-pointer"
                    title="Cancel recording"
                    aria-label="Cancel recording"
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : transcribing ? (
                <div className="flex items-center gap-2 rounded-full border border-line bg-raised px-3 py-1.5 text-xs text-muted shadow-xs">
                  <Loader2 size={13} className="animate-spin text-accent" />
                  <span>Transcribing with local Whisper…</span>
                </div>
              ) : (
                !running && (
                  <Tooltip content="Dictate with local Whisper">
                    <button
                      type="button"
                      onClick={startRecording}
                      disabled={sending}
                      aria-label="Dictate message"
                      className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted transition-colors duration-(--dur-fast) hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 touch:size-10"
                    >
                      <Mic size={18} aria-hidden="true" />
                    </button>
                  </Tooltip>
                )
              )}

              {running ? (
                <>
                  {workingMode && (
                    <Tooltip content={workingMode === "steer" ? t("composer.steerHint") : t("composer.queueHint")}>
                      <span>
                        <button
                          type="button"
                          onClick={onSend}
                          disabled={!canSend}
                          aria-label={workingMode === "steer" ? t("composer.steerHint") : t("composer.queueHint")}
                          className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent text-accent-fg shadow-xs transition-all duration-(--dur-fast) hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 touch:size-10"
                        >
                          <ArrowUp size={16} aria-hidden="true" />
                        </button>
                      </span>
                    </Tooltip>
                  )}
                  <Tooltip content={stopping ? t("composer.stopping") : t("composer.stopGenerating")}>
                    <button
                      type="button"
                      onClick={onStop}
                      disabled={stopping}
                      aria-label={stopping ? t("composer.stoppingLabel") : t("composer.stopGenerating")}
                      className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-danger/40 bg-danger/10 text-danger shadow-xs transition-colors duration-(--dur-fast) hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-50 touch:size-10"
                    >
                      <Square size={13} aria-hidden="true" />
                    </button>
                  </Tooltip>
                </>
              ) : (
                <Tooltip content={sending ? t("composer.sending") : canSend ? t("composer.sendHint") : (blockedReason ?? t("composer.enterMessageHint"))}>
                  <span>
                    <button
                      type="button"
                      onClick={onSend}
                      disabled={!canSend}
                      aria-label={t("composer.sendMessage")}
                      className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent text-accent-fg shadow-xs transition-all duration-(--dur-fast) hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 touch:size-10"
                    >
                      <ArrowUp size={16} aria-hidden="true" />
                    </button>
                  </span>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
        {onSaveAsSkill && (
          <div className="mt-1 flex justify-end px-3">
            <button type="button" onClick={onSaveAsSkill} className="cursor-pointer text-xs text-muted underline-offset-2 hover:text-ink hover:underline">
              {t("composer.saveSkill")}
            </button>
          </div>
        )}
        {blockedAction && blockedReason && (
          <div className="mt-2 px-3">
            <Button variant="primary" size="sm" onClick={blockedAction.onClick}>{blockedAction.label}</Button>
          </div>
        )}
        {dictationError && <p role="alert" className="mt-1.5 px-3 text-xs text-muted">{dictationError}</p>}
        {blockedReason && value.trim() !== "" && <p className="mt-1.5 px-3 text-xs text-muted">{blockedReason}</p>}
      </div>
    </div>
  );
}
