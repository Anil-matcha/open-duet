import { AuthGate } from "@/components/AuthGate";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { GeneralSettings } from "@/components/settings/GeneralSettings";

export const metadata = { title: "Settings · Open Duet" };

export default function Page() {
  return (
    <AuthGate>
      <SettingsShell>
        <GeneralSettings />
      </SettingsShell>
    </AuthGate>
  );
}
