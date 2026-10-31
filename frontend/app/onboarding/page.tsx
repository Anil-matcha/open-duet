import { Suspense } from "react";
import { AuthGate } from "@/components/AuthGate";
import { OnboardingApp } from "@/components/OnboardingApp";
import { Spinner } from "@/components/ui/Spinner";

export default function OnboardingPage() {
  return (
    <Suspense fallback={<div className="flex justify-center p-10 text-muted"><Spinner label="Loading setup…" /></div>}>
      <AuthGate><OnboardingApp /></AuthGate>
    </Suspense>
  );
}
