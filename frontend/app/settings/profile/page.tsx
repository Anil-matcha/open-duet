import { AuthGate } from "@/components/AuthGate";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { ProfileSettings } from "@/components/settings/ProfileSettings";

export const metadata = { title: "Profile · Open Duet" };

export default function Page() {
  return (
    <AuthGate>
      <SettingsShell>
        <ProfileSettings />
      </SettingsShell>
    </AuthGate>
  );
}

