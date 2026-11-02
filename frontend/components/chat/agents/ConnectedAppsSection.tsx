"use client";

import Link from "next/link";
import { agentAppOptions, levelOf, withAccount, withApp, type AccountScopes, type ComposioAccount, type Level, type Scopes } from "@/lib/connected-apps";

const SEGMENT = "inline-flex min-h-8 cursor-pointer items-center rounded border border-transparent px-2.5 text-xs font-medium text-muted hover:bg-hover hover:text-ink peer-checked:border-accent peer-checked:bg-accent/15 peer-checked:text-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent touch:min-h-11";

export function ConnectedAppsSection({
  appAccounts,
  connectorScopes,
  connectorAccountScopes,
  busy,
  onScopesChange,
  onAccountScopesChange,
}: {
  appAccounts: ComposioAccount[] | null;
  connectorScopes: Scopes;
  connectorAccountScopes: AccountScopes;
  busy: boolean;
  onScopesChange: (scopes: Scopes) => void;
  onAccountScopesChange: (scopes: AccountScopes) => void;
}) {
  const apps = agentAppOptions(appAccounts, connectorScopes);

  return (
    <div className="space-y-4" role="group" aria-label="Connected apps access">
      {apps.map((app) => {
        const level = levelOf(connectorScopes, app.slug);
        const options: { value: Level; label: string }[] = [
          { value: "off", label: "Off" },
          { value: "read", label: "Read only" },
          ...(app.write ? [{ value: "write" as const, label: "Read and change" }] : []),
        ];
        const helper = level === "off"
          ? "This agent cannot use this app."
          : level === "read"
            ? `${app.generic ? "Look up only." : "Read only."} ${app.read}`
            : `${app.generic ? "Look up and run." : "Read and change."} ${app.write ?? ""}`;

        const accounts = appAccounts?.filter((account) => account.toolkit === app.slug && account.status === "ACTIVE") ?? [];
        const selected = connectorAccountScopes[app.slug] ?? [];
        const unavailable = selected.filter((id) => !accounts.some((account) => account.id === id));

        return (
          <fieldset key={app.slug} className="min-w-0 space-y-2 rounded-field border border-line p-3">
            <legend className="px-1 text-sm font-medium text-ink">
              {app.label}
              {app.generic && <span className="ml-2 text-xs font-normal text-muted">No built-in tools; every action asks you first.</span>}
            </legend>
            <div role="radiogroup" aria-label={`${app.label} access`} className="inline-flex max-w-full flex-wrap gap-1 rounded-md border border-line bg-inset p-1">
              {options.map((option) => (
                <label key={option.value} className="relative">
                  <input
                    type="radio"
                    name={`app-${app.slug}`}
                    className="peer sr-only"
                    disabled={busy}
                    checked={level === option.value}
                    onChange={() => onScopesChange(withApp(connectorScopes, app.slug, option.value))}
                  />
                  <span className={SEGMENT}>{option.label}</span>
                </label>
              ))}
            </div>
            <p className="text-xs leading-5 text-muted" aria-live="polite">{helper}</p>

            {level !== "off" && (
              <div className="space-y-1 border-l border-line pl-3">
                <p className="text-xs text-muted">Allow this agent to use these connected accounts:</p>
                {appAccounts === null ? (
                  <p className="text-xs text-muted">Loading connected accounts…</p>
                ) : (
                  <>
                    {accounts.length ? accounts.map((account) => (
                      <label key={account.id} className="flex min-h-8 cursor-pointer items-center gap-2 text-xs touch:min-h-11">
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={selected.includes(account.id)}
                          onChange={(event) => onAccountScopesChange(withAccount(connectorAccountScopes, app.slug, account.id, event.target.checked))}
                        />
                        <span>{account.alias || account.id}</span>
                      </label>
                    )) : (
                      <p className="text-xs text-muted">No connected account is available. Connect one on the <Link href="/apps/" className="text-accent underline underline-offset-2">Apps page</Link>.</p>
                    )}
                    {unavailable.map((id) => (
                      <label key={id} className="flex min-h-8 cursor-pointer items-center gap-2 text-xs touch:min-h-11">
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked
                          onChange={() => onAccountScopesChange(withAccount(connectorAccountScopes, app.slug, id, false))}
                        />
                        <span>Unavailable account ({id}) · remove access</span>
                      </label>
                    ))}
                    {selected.length === 0 && <p className="text-xs text-muted">No accounts selected; this app is unavailable to the agent.</p>}
                  </>
                )}
              </div>
            )}
          </fieldset>
        );
      })}
      <p className="text-xs leading-5 text-muted">
        <Link href="/apps/" className="text-accent underline underline-offset-2">Connect apps first on the Apps page</Link>, then choose which exact accounts this agent can use. Access is used only in conversations you start, never in routines or from outside messages.
      </p>
    </div>
  );
}
