import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "../../../src/ui/button";

// Rendered when loadEvent() returns null and the page calls notFound():
// the event doesn't exist, isn't published/completed yet, or was
// cancelled. Deliberately generic (never confirms or denies a draft exists
// at this id), same posture as app/u/[handle]/not-found.tsx. Next
// auto-injects <meta name="robots" content="noindex"> for any
// notFound()-triggered render, so that doesn't need repeating here.
export const metadata: Metadata = { title: "Not found · GateKeep" };

export default function NotFound() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-16 text-center sm:px-6">
      <h1 className="font-syne text-2xl font-extrabold text-gk-text sm:text-3xl">Not found</h1>
      <p className="mt-2 font-sora text-sm text-gk-muted">No event at that link.</p>
      <Button asChild className="mt-4">
        <Link href="/gigs">Browse gigs</Link>
      </Button>
    </main>
  );
}
