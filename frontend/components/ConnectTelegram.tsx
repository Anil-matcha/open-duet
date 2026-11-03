"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError, LinkCode } from "@/lib/api";
import { Button, Card, ErrorText } from "./Card";
import { Button as UiButton } from "@/components/ui/Button";
import { useT } from "@/lib/use-i18n";

const POLL_INTERVAL_MS = 2000;

function isGuestId(userId: string) {
  return userId.startsWith("web_");
}

export function ConnectTelegram({
  userId,
  onLinked,
  onReset,
  variant = "legacy",
}: {
  userId: string | null;
  // The server sets the identity: from the link code it saw claimed, or a new guest id.
  onLinked: (identity: { link_code: string } | { guest: true }) => void;
  onReset: () => void;
  variant?: "legacy" | "settings";
}) {
  const t = useT();
  const [mode, setMode] = useState<"choice" | "telegram">("choice");
  const [linkCode, setLinkCode] = useState<LinkCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeCodeRef = useRef<string | null>(null);
  const copyButtonRef = useRef<HTMLButtonElement | null>(null);
  const linkButtonRef = useRef<HTMLButtonElement | null>(null);
  const shouldReturnFocusRef = useRef(false);
  const linkCommandId = useId();

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    activeCodeRef.current = null;
  };

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      activeCodeRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (variant !== "settings") return;
    if (linkCode) {
      copyButtonRef.current?.focus();
    } else if (shouldReturnFocusRef.current) {
      shouldReturnFocusRef.current = false;
      linkButtonRef.current?.focus();
    }
  }, [linkCode, variant]);

  const generateCode = async () => {
    setError(null);
    setLoading(true);
    try {
      const code = await api.createLinkCode();
      setLinkCode(code);
      activeCodeRef.current = code.code;

      pollRef.current = setInterval(async () => {
        try {
          const status = await api.getLinkStatus(code.code);
          if (activeCodeRef.current !== code.code) return;
          if (status.status === "claimed" && status.user_id) {
            stopPolling();
            setLinkCode(null);
            onLinked({ link_code: code.code });
          } else if (status.status === "expired") {
            stopPolling();
            setError(variant === "settings" ? t("channels.codeExpired") : "Code expired — generate a new one.");
            setLinkCode(null);
          }
        } catch {
          // transient network hiccup — keep polling
        }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : variant === "settings" ? t("channels.generateCodeError") : "Could not generate a code.");
    } finally {
      setLoading(false);
    }
  };

  const cancelLink = () => {
    shouldReturnFocusRef.current = true;
    stopPolling();
    setLinkCode(null);
    setCopied(false);
    setError(null);
  };

  const copyLinkCommand = async () => {
    if (!linkCode) return;
    try {
      await navigator.clipboard.writeText(`/link ${linkCode.code}`);
      setCopied(true);
      setError(null);
    } catch {
      setCopied(false);
      setError(t("channels.copyFailed"));
    }
  };

  if (variant === "settings") {
    const connected = Boolean(userId && !isGuestId(userId));
    const expiryDate = linkCode?.expires_at ? new Date(linkCode.expires_at) : null;
    const formattedExpiry = expiryDate && !Number.isNaN(expiryDate.getTime())
      ? expiryDate.toLocaleString()
      : linkCode?.expires_at;
    const botLink = linkCode?.bot_username
      ? `https://t.me/${linkCode.bot_username}`
      : null;

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="min-w-0 text-sm text-ink">
            {connected
              ? t("channels.connectedAs", { userId: userId ?? "" })
              : t("channels.notConnected")}
          </p>
          {!linkCode && (connected ? (
            <UiButton variant="ghost" onClick={onReset}>
              {t("channels.disconnect")}
            </UiButton>
          ) : (
            <UiButton ref={linkButtonRef} variant="primary" loading={loading} onClick={generateCode}>
              {t("channels.linkTelegram")}
            </UiButton>
          ))}
        </div>

        {linkCode && (
          <div className="space-y-3 rounded-field border border-line bg-inset p-4">
            <p className="text-sm text-muted">{t("channels.sendLinkCommand")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code id={linkCommandId} className="break-all rounded bg-hover px-2 py-1.5 font-mono text-base font-semibold text-ink">
                /link {linkCode.code}
              </code>
              <UiButton ref={copyButtonRef} variant="secondary" aria-describedby={linkCommandId} onClick={copyLinkCommand}>
                {copied ? t("channels.copied") : t("channels.copy")}
              </UiButton>
            </div>
            <p role="status" aria-live="polite" className="text-sm text-muted">
              {copied ? `${t("channels.copied")}. ` : ""}{t("channels.waitingForLink")}
            </p>
            {formattedExpiry && (
              <p className="text-xs text-muted">
                {t("channels.expiresAt", { time: formattedExpiry })}
              </p>
            )}
            {botLink && (
              <a
                href={botLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block rounded-sm text-sm font-medium text-accent underline hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {t("channels.openTelegram")}
              </a>
            )}
            <div>
              <UiButton variant="ghost" onClick={cancelLink}>
                {t("common.cancel")}
              </UiButton>
            </div>
          </div>
        )}

        <ErrorText message={error} />
      </div>
    );
  }

  if (userId) {
    return (
      <Card step={1} title="Get started" done>
        {isGuestId(userId) ? (
          <p className="text-sm text-muted">
            Continuing without Telegram.
          </p>
        ) : (
          <p className="text-sm text-muted">
            Linked as Telegram user <code className="font-mono">{userId}</code>.
          </p>
        )}
        <UiButton variant="ghost" className="mt-2" onClick={onReset}>
          Start over
        </UiButton>
      </Card>
    );
  }

  const botLink = linkCode?.bot_username
    ? `https://t.me/${linkCode.bot_username}`
    : null;

  if (mode === "choice") {
    return (
      <Card step={1} title="Get started">
        <p className="mb-3 text-sm text-muted">
          You don&apos;t need Telegram to use this — continue as a guest, or
          link Telegram if you want the same account/history there too.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onLinked({ guest: true })}>
            Continue without Telegram
          </Button>
          <UiButton variant="secondary" onClick={() => setMode("telegram")}>
            Link Telegram instead
          </UiButton>
        </div>
      </Card>
    );
  }

  return (
    <Card step={1} title="Get started">
      <p className="mb-3 text-sm text-muted">
        Generates a one-time code. Send it to the bot in Telegram to link your
        account — no token or password needed here.
      </p>

      {!linkCode && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={generateCode} disabled={loading}>
            {loading ? "Generating…" : "Generate code"}
          </Button>
          <UiButton variant="ghost" onClick={() => setMode("choice")}>
            Back
          </UiButton>
        </div>
      )}

      {linkCode && (
        <div className="space-y-2">
          <p className="text-sm">
            Send this to the bot:{" "}
            <code className="rounded bg-inset px-2 py-1 font-mono text-base font-semibold">
              /link {linkCode.code}
            </code>
          </p>
          {botLink && (
            <a
              href={botLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-sm font-medium text-accent underline hover:opacity-80"
            >
              Open Telegram →
            </a>
          )}
          <p className="text-xs text-muted">Waiting for you to send it…</p>
        </div>
      )}

      <ErrorText message={error} />
    </Card>
  );
}
