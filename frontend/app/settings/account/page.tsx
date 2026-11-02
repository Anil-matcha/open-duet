import { AuthGate } from "@/components/AuthGate";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { AccountSettings } from "@/components/settings/AccountSettings";

export const metadata = { title: "Account \& privacy · Open Duet" };

export default function Page() {
  return (
    <AuthGate>
      <SettingsShell>
        <AccountSettings />
      </SettingsShell>
    </AuthGate>
  );
}
