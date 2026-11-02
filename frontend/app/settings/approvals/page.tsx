import { AuthGate } from "@/components/AuthGate";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { ApprovalsSettings } from "@/components/settings/ApprovalsSettings";

export const metadata = { title: "Approvals · Open Duet" };

export default function Page() {
  return (
    <AuthGate>
      <SettingsShell>
        <ApprovalsSettings />
      </SettingsShell>
    </AuthGate>
  );
}
