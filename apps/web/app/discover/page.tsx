import type { Metadata } from "next";
import { DiscoverClient } from "./DiscoverClient";

// Thin Server Component wrapper, same split BuyTicketsFlow/EventPageClient
// and app/sign-in/page.tsx already use: metadata lives here (a "use client"
// file cannot export it), all the actual signed-in-only rendering lives in
// DiscoverClient.
export const metadata: Metadata = { title: "Discover" };

export default function DiscoverPage() {
  return <DiscoverClient />;
}
