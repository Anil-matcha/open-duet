"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/Input";
import { EmptyPanel, ErrorState, LoadingState } from "./PanelState";
import {
  categoryLabel,
  filterTemplates,
  requirementLabel,
  type AgentTemplate,
  type TemplateCatalog,
  type TemplateSkill,
} from "@/lib/templates";

const CHIP = "cursor-pointer rounded-full border px-3 py-1 text-xs font-medium";

// Ready-made agents: browse and search a bundled list, then Add one. Add only
// hands the template to the new-agent form; nothing is created here.
export function TemplatesGallery({ onAdd }: { onAdd: (template: AgentTemplate) => void }) {
  const [catalog, setCatalog] = useState<TemplateCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .listTemplates()
      .then((value) => { if (!cancelled) setCatalog(value); })
      .catch(() => { if (!cancelled) setError("Could not load the templates."); });
    return () => { cancelled = true; };
  }, [reload]);

  const shown = useMemo(() => filterTemplates(catalog?.templates ?? [], query, category), [catalog, query, category]);

  if (error) return <ErrorState message={error} onRetry={() => { setError(null); setReload((n) => n + 1); }} />;
  if (!catalog) return <LoadingState rows={4} />;

  return (
    <div className="space-y-3">
      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search templates"
        aria-label="Search templates"
      />
      <div className="flex flex-wrap gap-2" role="group" aria-label="Category">
        {[null, ...catalog.categories].map((value) => (
          <button
            key={value ?? "all"}
            type="button"
            aria-pressed={category === value}
            onClick={() => setCategory(value)}
            className={`${CHIP} ${category === value ? "border-accent bg-inset" : "border-line hover:bg-hover"}`}
          >
            {value === null ? "All" : categoryLabel(value)}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <EmptyPanel title="No templates match" description="Try another word or category." />
      ) : (
        <ul className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((template) => (
            <li key={template.id} className="flex min-w-0 flex-col rounded-md border border-line p-3">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-accent-fg"
                  style={{ backgroundColor: template.color }}
                >
                  {template.name.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{template.name}</p>
                  <p className="truncate text-xs text-muted">{template.role} · {categoryLabel(template.category)}</p>
                </div>
              </div>
              <p className="mt-2 text-xs">{template.description}</p>
              {template.example_requests[0] && (
                <p className="mt-2 break-words text-xs italic text-muted">“{template.example_requests[0]}”</p>
              )}
              <div className="mt-2 flex flex-wrap gap-1">
                {template.requires.map((item) => (
                  <span key={item} className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">
                    Needs {requirementLabel(item)}{template.available ? "" : " · not available yet"}
                  </span>
                ))}
                {template.skills.length > 0 && (
                  <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">
                    {template.skills.length} suggested skill{template.skills.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              <div className="mt-auto pt-3">
                <button
                  type="button"
                  onClick={() => onAdd(template)}
                  disabled={!template.available}
                  aria-label={`Add ${template.name}`}
                  className="cursor-pointer rounded-md border border-line px-3 py-1 text-xs font-medium hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {template.available ? "Add" : "Unavailable"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The skills a template suggests, each optional, shown in the new-agent form.
export function TemplateSkillChoices({
  skills,
  chosen,
  disabled,
  onChange,
}: {
  skills: TemplateSkill[];
  chosen: string[];
  disabled: boolean;
  onChange: (chosen: string[]) => void;
}) {
  return (
    <fieldset className="text-xs text-muted">
      <legend>Suggested skills (added after the agent is created)</legend>
      <ul className="mt-1 space-y-1">
        {skills.map((skill) => (
          <li key={skill.name}>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                disabled={disabled}
                checked={chosen.includes(skill.name)}
                onChange={() => onChange(chosen.includes(skill.name) ? chosen.filter((n) => n !== skill.name) : [...chosen, skill.name])}
              />
              <span className="min-w-0 break-words">
                <span className="font-medium text-foreground">{skill.name}</span> · {skill.description}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
