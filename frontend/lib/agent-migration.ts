export type AgentMigrationSource = "grok" | "hermes" | "other" | "openbot";

export type AgentMigrationPreview = {
  document: Record<string, unknown>;
  sourceLabel: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  mappingNotice?: string;
};

const MAX_EXPORT_BYTES = 1_000_000;
const MAX_NAME = 80;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4_000;
const MAX_INSTRUCTIONS_BYTES = 24_000;

export const GROK_AGENT_EXPORT_PROMPT = [
  "Export this bot as one versioned JSON manifest so I can review and recreate its basic setup in another agent app.",
  "Keep the full standing instructions exactly as written. Include notes only if they are useful and text-only skills only if their complete definition is plain text.",
  "{",
  '  "format": "open-dots.agent-migration",',
  '  "version": 1,',
  '  "source": "grok",',
  '  "agents": [{ "format": "open-dots.agent", "version": 1, "agent": { "name": "Agent name", "title": "Short role title", "description": "Short description", "instructions": "Full standing instructions" }, "notes": { "MEMORY.md": "Optional notes" }, "skills": [{ "name": "Skill name", "description": "Text description", "body": "Text-only skill body" }] }]',
  "}",
  "Omit credentials, private customer data, connections, routines, tools, executable skills, files and conversation history. Do not include avatars, schedules, or workspace state.",
  "Do not add explanatory text outside the JSON. Optional notes and skills may be omitted.",
  "Replace every example value with real content. Omit the notes or skills property when there is no real content; never return labels such as Agent name, Optional notes, or Skill name as data.",
  "Do not add explanatory text outside the JSON block.",
].join("\n");

export const HERMES_AGENT_EXPORT_PROMPT = [
  "Export the basic setup of the Hermes Agent profile we are using as one versioned JSON manifest for review in another agent app.",
  "Copy the full standing persona/instructions from SOUL.md when available. Include optional notes and text-only skills when useful.",
  "{",
  '  "format": "open-dots.agent-migration",',
  '  "version": 1,',
  '  "source": "hermes",',
  '  "agents": [{ "format": "open-dots.agent", "version": 1, "agent": { "name": "Agent name", "title": "Short role title", "description": "Short description", "instructions": "Full standing persona and instructions" }, "notes": { "MEMORY.md": "Optional notes" }, "skills": [{ "name": "Skill name", "description": "Text description", "body": "Text-only skill body" }] }]',
  "}",
  "Omit credentials, private customer data, connections, routines, tools, executable skills, files and conversation history. Do not include avatars, schedules, or workspace state.",
  "Do not add explanatory text outside the JSON. Optional notes and skills may be omitted.",
  "Replace every example value with real content. Omit the notes or skills property when there is no real content; never return labels such as Agent name, Optional notes, or Skill name as data.",
  "Do not add explanatory text outside the JSON block.",
].join("\n");

export const GROK_AGENT_BASIC_EXPORT_PROMPT = [
  "Export one agent as a single JSON object for a basic setup import.",
  '{ "name": "Agent name", "title": "Short role title", "description": "Short description", "instructions": "Full standing instructions" }',
  "Omit credentials, private data, connections, routines, tools, skills, files and conversation history.",
  "Return only the JSON object.",
].join("\n");

export const HERMES_AGENT_BASIC_EXPORT_PROMPT = [
  "Export one Hermes Agent profile as a single JSON object for a basic setup import. Copy standing instructions from SOUL.md when available.",
  '{ "name": "Agent name", "title": "Short role title", "description": "Short description", "instructions": "Full standing instructions" }',
  "Omit credentials, private data, memories, connections, routines, tools, skills, files and conversation history.",
  "Return only the JSON object.",
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(...values: unknown[]): string {
  return values.map(text).find(Boolean) ?? "";
}

function parseObject(input: string): Record<string, unknown> {
  if (new TextEncoder().encode(input).byteLength > MAX_EXPORT_BYTES) {
    throw new Error("That export is larger than 1 MB.");
  }

  const candidates = [input.trim()];
  const fence = String.fromCharCode(96).repeat(3);
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf(fence, cursor);
    if (start < 0) break;
    const lineEnd = input.indexOf("\n", start + fence.length);
    if (lineEnd < 0) break;
    const end = input.indexOf(fence, lineEnd + 1);
    if (end < 0) break;
    candidates.push(input.slice(lineEnd + 1, end).trim());
    cursor = end + fence.length;
  }

  const firstBrace = input.indexOf("{");
  const lastBrace = input.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(input.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of new Set(candidates)) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next bounded JSON candidate.
    }
  }
  throw new Error("Paste a JSON object from the export. The text could not be read as JSON.");
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseExternalAgentSetup(
  input: string,
  source: AgentMigrationSource,
): AgentMigrationPreview {
  const root = parseObject(input);
  const isManifest = root.format === "open-dots.agent-migration" && root.version === 1;
  const firstManifestAgent = isManifest && Array.isArray(root.agents) && isRecord(root.agents[0])
    ? root.agents[0]
    : {};
  const nestedAgent = isRecord(firstManifestAgent.agent)
    ? firstManifestAgent.agent
    : isRecord(root.agent) ? root.agent : {};
  const persona = isRecord(root.persona) ? root.persona : {};
  const name = firstText(root.name, root.botName, nestedAgent.name, persona.name);
  const title = firstText(root.title, nestedAgent.title, persona.title);
  const description = firstText(root.description, nestedAgent.description, persona.description);
  const instructions = firstText(
    root.instructions,
    root.systemPrompt,
    root.system_prompt,
    root.soul,
    root.prompt,
    nestedAgent.instructions,
    nestedAgent.systemPrompt,
    nestedAgent.soul,
    persona.instructions,
    source === "grok" ? persona.description : "",
  );

  if (!name) throw new Error("The export needs an agent name.");
  if (/[\r\n]/u.test(name)) throw new Error("The agent name must fit on one line.");
  if (name.length > MAX_NAME) throw new Error("The agent name is longer than 80 characters.");
  if (title.length > MAX_TITLE) throw new Error("The agent title is longer than 200 characters.");
  if (description.length > MAX_DESCRIPTION) throw new Error("The description is longer than 4,000 characters.");
  if (!instructions) throw new Error("The export needs the agent's standing instructions.");
  if (utf8Length(instructions) > MAX_INSTRUCTIONS_BYTES) {
    throw new Error("The instructions are longer than 24,000 bytes.");
  }

  const agent: Record<string, unknown> = { name, instructions };
  if (title) agent.title = title;
  if (description && description !== instructions) agent.description = description;
  const notes = isRecord(firstManifestAgent.notes) ? firstManifestAgent.notes : {};
  const skills = Array.isArray(firstManifestAgent.skills) ? firstManifestAgent.skills : [];

  return {
    document: {
      format: "open-dots.agent",
      version: 1,
      agent,
      ...(Object.keys(notes).length ? { notes } : {}),
      ...(skills.length ? { skills } : {}),
    },
    sourceLabel: source === "grok"
      ? "Grok Bot"
      : source === "hermes"
        ? "Hermes Agent"
        : source === "openbot"
          ? "OpenBot database"
          : "Another agent app",
    name,
    title,
    description: description === instructions ? "" : description,
    instructions,
  };
}
