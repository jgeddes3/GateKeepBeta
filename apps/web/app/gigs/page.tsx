import type { Metadata } from "next";
import Link from "next/link";
import { GigBrowse } from "../../src/bookings/GigBrowse";

export const metadata: Metadata = {
  title: "Find gigs · GateKeep",
  description: "Browse open gigs looking for an act.",
};

// Thin server wrapper (metadata only) around the interactive client
// component — mirrors app/u/[handle]/page.tsx's split between page.tsx and
// its content component, though this page has no per-request data of its
// own to load server-side (GigBrowse runs the client-SDK query itself; see
// its own comment for why that's the provable shape under firestore.rules).
export default function GigsPage() {
  return (
    <main style={{ maxWidth: 720, margin: "40px auto", display: "grid", gap: 24 }}>
      <Link href="/" style={{ color: "#666", fontSize: 14 }}>← GateKeep</Link>
      <h1>Find gigs</h1>
      <GigBrowse />
    </main>
  );
}
