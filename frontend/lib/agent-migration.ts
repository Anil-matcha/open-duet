export type AgentMigrationSource = "grok" | "other";

export type AgentMigrationPreview = {
  document: Record<string, unknown>;
  sourceLabel: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
};

const MAX_EXPORT_BYTES = 1_000_000;
const MAX_NAME = 80;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4_000;
const MAX_INSTRUCTIONS_BYTES = 24_000;

export const GROK_AGENT_EXPORT_PROMPT = [
  "Please export this bot so I can recreate its basic setup in another agent app.",
  "Reply with one JSON code block in this shape. Keep the full standing instructions exactly as written.",
  "{",
  '  "format": "open-dots.grok-agent/1",',
  '  "name": "Agent name",',
  '  "title": "Short role title",',
  '  "description": "Short description",',
  '  "instructions": "Full standing instructions"',
  "}",
  "Do not include API keys, passwords, tokens, private customer data, connected accounts, routines, tools, skills, or conversation history.",
  "Use empty strings for optional fields you do not have. Do not add explanatory text outside the JSON block.",
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
  const nestedAgent = isRecord(root.agent) ? root.agent : {};
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

  const agent: Record<string, string> = { name, instructions };
  if (title) agent.title = title;
  if (description && description !== instructions) agent.description = description;

  return {
    document: { format: "open-dots.agent", version: 1, agent },
    sourceLabel: source === "grok" ? "Grok Bot" : "Another agent app",
    name,
    title,
    description: description === instructions ? "" : description,
    instructions,
  };
}
