"use client";

import Link from "next/link";
import { useState } from "react";
import { useSession } from "@/components/AuthGate";
import { ConnectTelegram } from "@/components/ConnectTelegram";
import { Applies } from "@/components/settings/Applies";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { Banner } from "@/components/ui/Banner";
import { ApiError } from "@/lib/api";
import { auth } from "@/lib/auth";
import { useT } from "@/lib/use-i18n";

function ChannelsContent() {
  const t = useT();
  const { session, setUserId } = useSession();
  const userId = session?.user_id ?? null;
  const [identityError, setIdentityError] = useState<string | null>(null);

  const handleLinked = async (identity: { link_code: string } | { guest: true }) => {
    setIdentityError(null);
    try {
      const { user_id } = await auth.setIdentity(identity);
      setUserId(user_id);
    } catch (err) {
      setIdentityError(err instanceof ApiError ? `Could not save who you are. ${err.message}` : "Could not save who you are.");
    }
  };

  const handleReset = async () => {
    setIdentityError(null);
    try {
      await auth.clearIdentity();
    } catch (err) {
      setIdentityError(err instanceof ApiError ? `Could not start over. ${err.message}` : "Could not start over.");
      return;
    }
    setUserId(null);
  };

  return (
    <div className="space-y-6">
      <section
        id="setting-channels-telegram"
        data-setting-id="setting-channels-telegram"
        data-setting-container
        tabIndex={-1}
        aria-label={t("channels.telegramTitle")}
      >
        <SettingsCard
          title={t("channels.telegramTitle")}
          description={t("channels.telegramDescription")}
          action={<Applies when="now" />}
        >
          <ConnectTelegram userId={userId} onLinked={handleLinked} onReset={handleReset} variant="settings" />
        </SettingsCard>
        {identityError && <Banner tone="danger">{identityError}</Banner>}
      </section>

      <div
        id="setting-channels-boat-tasks"
        data-setting-id="setting-channels-boat-tasks"
        data-setting-container
        tabIndex={-1}
      >
        <SettingsCard
          title={t("channels.boatTasksTitle")}
          description={<span className="block truncate">{t("channels.boatTasksCompactDescription")}</span>}
          action={(
            <Link
              href="/tasks/"
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-field border border-line bg-raised px-4 text-sm font-medium text-ink hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent touch:min-h-12"
            >
              {t("channels.openBoatTasks")}
            </Link>
          )}
        />
      </div>
    </div>
  );
}

export function ChannelsSettings() {
  return <ChannelsContent />;
}
