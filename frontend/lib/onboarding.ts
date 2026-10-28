import { request } from "./api";

export type OnboardingDraft = {
  step: number;
  provider: string;
  model: string | null;
  name: string;
  purpose: string;
  first_request: string;
  create_agent: boolean;
  make_lead: boolean;
};

export type OnboardingState = {
  version: number;
  status: "pending" | "skipped" | "configured";
  draft: OnboardingDraft;
  agent_id: number | null;
  first_reply_at: string | null;
  execution_host: "desktop" | "server";
  existing_agents: boolean;
};

export const STARTER_ROLES = [
  { name: "Writing partner", purpose: "Help me draft and improve clear writing. Ask about the audience and intended outcome, preserve my meaning, and flag claims that need a source.", first_request: "Help me improve a piece of writing. Ask what I am working on." },
  { name: "Project researcher", purpose: "Help me research a project. Clarify the question, compare evidence, distinguish facts from assumptions, and cite sources when available.", first_request: "Help me research a project. Ask me about the question and constraints." },
  { name: "Planning assistant", purpose: "Help me turn goals into realistic plans. Ask about deadlines and constraints, suggest concrete next actions, and leave changes to calendars or other apps for my approval.", first_request: "Help me plan my next week. Ask me about my goals and commitments." },
] as const;

export function onboardingChatHref(state: OnboardingState): string {
  const query = new URLSearchParams({ onboarding: "1" });
  if (state.agent_id !== null) query.set("agent", String(state.agent_id));
  else {
    query.set("engine", state.draft.provider);
    if (state.draft.model) query.set("model", state.draft.model);
  }
  return `/chat/?${query}`;
}

export const onboarding = {
  get: () => request<OnboardingState>("/onboarding"),
  save: (expected_version: number, draft: OnboardingDraft) => request<OnboardingState>("/onboarding", { method: "PUT", body: JSON.stringify({ expected_version, draft }) }),
  complete: (expected_version: number, draft: OnboardingDraft) => request<OnboardingState>("/onboarding/complete", { method: "POST", body: JSON.stringify({ expected_version, draft }) }),
  skip: (expected_version: number) => request<OnboardingState>("/onboarding/skip", { method: "POST", body: JSON.stringify({ expected_version }) }),
  restart: (expected_version: number) => request<OnboardingState>("/onboarding/restart", { method: "POST", body: JSON.stringify({ expected_version }) }),
  firstReply: (thread_id: number) => request<OnboardingState>("/onboarding/first-reply", { method: "POST", body: JSON.stringify({ thread_id }) }),
};
