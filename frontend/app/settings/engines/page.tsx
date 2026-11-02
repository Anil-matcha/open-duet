import { AuthGate } from "@/components/AuthGate";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { EnginesSettings } from "@/components/settings/EnginesSettings";

export const metadata = { title: "Engines · Open Duet" };

export default function Page() {
  return (
    <AuthGate>
      <SettingsShell>
        <EnginesSettings />
      </SettingsShell>
    </AuthGate>
  );
}
