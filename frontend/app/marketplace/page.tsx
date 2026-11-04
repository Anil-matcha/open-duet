import { AuthGate } from "@/components/AuthGate";
import { MarketplaceApp } from "@/components/MarketplaceApp";

export const metadata = { title: "MCP Marketplace · Open Duet" };

export default function MarketplacePage() {
  return <AuthGate><MarketplaceApp /></AuthGate>;
}
