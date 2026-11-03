"use client";

import { useId, useMemo, useRef, useState } from "react";

export type RoomMentionMember = { agent_id: number; name: string };

export type RoomMentionComposerProps = {
  value: string;
  onChange: (value: string) => void;
  members: RoomMentionMember[];
  disabled?: boolean;
  label: string;
  placeholder?: string;
  everyoneLabel: string;
  memberToken?: (member: RoomMentionMember) => string;
  /** Optional localized accessible description for duplicate-name identities. */
  memberIdentityLabel?: (agentId: number) => string;
  rows?: number;
  maxLength?: number;
  className?: string;
};

type Suggestion = { key: string; label: string; token: string };

export function RoomMentionComposer({
  value,
  onChange,
  members,
  disabled = false,
  label,
  placeholder,
  everyoneLabel,
  memberToken = member => `@${member.name} `,
  memberIdentityLabel = id => `#${id}`,
  rows = 3,
  maxLength,
  className = "mt-1 w-full resize-y rounded-field border border-line bg-raised p-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
}: RoomMentionComposerProps) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const activeMention = useMemo(() => {
    const position = Math.min(caret, value.length);
    const before = value.slice(0, position);
    const at = before.lastIndexOf("@");
    if (at < 0 || (at > 0 && !/[\s([{"'_*~]/.test(before[at - 1]))) return null;
    const query = before.slice(at + 1);
    if (/[\r\n`]/.test(query)) return null;
    return { start: at, query };
  }, [caret, value]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!activeMention || dismissed || disabled) return [];
    const query = activeMention.query.toLocaleLowerCase();
    const options: Suggestion[] = [];
    if ("everyone".startsWith(query)) options.push({ key: "everyone", label: everyoneLabel, token: "@everyone " });
    for (const member of members) {
      if (member.name.toLocaleLowerCase().startsWith(query)) {
        options.push({ key: String(member.agent_id), label: member.name, token: memberToken(member) });
      }
    }
    return options;
  }, [activeMention, dismissed, disabled, everyoneLabel, memberToken, members]);

  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const member of members) {
      const name = member.name.normalize("NFKC").toLocaleLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [members]);

  const choose = (suggestion: Suggestion) => {
    const element = textarea.current;
    if (!element || !activeMention) return;
    const start = activeMention.start;
    const selectionEnd = element.selectionEnd ?? caret;
    const next = value.slice(0, start) + suggestion.token + value.slice(selectionEnd);
    const nextCaret = start + suggestion.token.length;
    onChange(next);
    setCaret(nextCaret);
    setDismissed(false);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!suggestions.length) {
      if (event.key === "Escape") setDismissed(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(index => (index + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(index => (index - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter") {
      if (event.key === "Enter" && event.shiftKey) return;
      event.preventDefault();
      choose(suggestions[activeIndex] ?? suggestions[0]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    }
  };

  const listId = `${id}-suggestions`;
  const activeId = suggestions.length ? `${id}-option-${suggestions[activeIndex % suggestions.length]?.key}` : undefined;

  return <div className="relative">
    <label htmlFor={`${id}-input`} className="block text-sm">{label}
      <textarea
        ref={textarea}
        id={`${id}-input`}
        value={value}
        onChange={event => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart);
          setDismissed(false);
          setActiveIndex(0);
        }}
        onKeyUp={event => setCaret(event.currentTarget.selectionStart)}
        onClick={event => { setCaret(event.currentTarget.selectionStart); setDismissed(false); }}
        onBlur={() => setDismissed(true)}
        onSelect={event => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        rows={rows}
        maxLength={maxLength}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        aria-controls={suggestions.length ? listId : undefined}
        aria-activedescendant={activeId}
        aria-haspopup="listbox"
        className={className}
      />
    </label>
    {suggestions.length > 0 && <ul id={listId} role="listbox" aria-label={label} className="absolute bottom-full z-20 mb-1 max-h-56 w-full overflow-y-auto rounded-field border border-line bg-raised p-1 shadow-lg">
      {suggestions.map((suggestion, index) => {
        const member = suggestion.key === "everyone" ? undefined : members.find(item => String(item.agent_id) === suggestion.key);
        const identity = member?.name.normalize("NFKC").toLocaleLowerCase();
        const isDuplicate = member && (duplicateNames.get(identity ?? "") ?? 0) > 1;
        const optionId = `${id}-option-${suggestion.key}`;
        return <li
          id={optionId}
          key={suggestion.key}
          role="option"
          aria-selected={index === activeIndex % suggestions.length}
          onMouseDown={event => event.preventDefault()}
          onClick={() => choose(suggestion)}
          className={`cursor-pointer rounded px-3 py-2 text-sm focus:outline-none ${index === activeIndex ? "bg-hover" : ""}`}
        >{suggestion.label}{isDuplicate ? <span className="ml-2 text-xs text-muted">{memberIdentityLabel(member.agent_id)}</span> : null}</li>;
      })}
    </ul>}
  </div>;
}
