import { Suspense } from "react";
import { AuthGate } from "@/components/AuthGate";
import { OnboardingApp } from "@/components/OnboardingApp";

export default function OnboardingPage() {
  return <Suspense fallback={<p className="p-6">Loading setup…</p>}><AuthGate><OnboardingApp /></AuthGate></Suspense>;
}
