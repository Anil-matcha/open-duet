import type { AccountScopes, Scopes } from "@/lib/connected-apps";

type AgentDraftState = {
  connector_scopes: Scopes;
  connector_account_scopes: AccountScopes;
  [field: string]: unknown;
};

// These maps and account selections represent sets. Canonical order keeps the
// editor clean when someone changes a value and then restores it.
export function draftSignature<T extends AgentDraftState>(draft: T): string {
  return JSON.stringify({
    ...draft,
    connector_scopes: Object.fromEntries(Object.entries(draft.connector_scopes).sort(([a], [b]) => a.localeCompare(b))),
    connector_account_scopes: Object.fromEntries(
      Object.entries(draft.connector_account_scopes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([app, accounts]) => [app, [...accounts].sort()]),
    ),
  });
}
