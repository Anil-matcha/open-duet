"use client";

import { DesktopAccountSection } from "@/components/DesktopAccountSection";
import { DesktopPermissions } from "@/components/DesktopPermissions";
import { DevicesSection } from "@/components/DevicesSection";
import { HistoryExport } from "@/components/HistoryExport";

export function AccountSettings() {
  return <div className="space-y-6">
    <DesktopAccountSection />
    <DevicesSection />
    <HistoryExport />
    <DesktopPermissions />
  </div>;
}
