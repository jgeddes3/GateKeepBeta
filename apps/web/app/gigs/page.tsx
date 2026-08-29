import type { Metadata } from "next";
import { GigBrowse } from "../../src/bookings/GigBrowse";

export const metadata: Metadata = {
  title: "Find gigs · GateKeep",
  description: "Browse open gigs looking for an act.",
};

// Thin server wrapper (metadata only) around the interactive client
// component: mirrors app/u/[handle]/page.tsx's split between page.tsx and
// its content component, though this page has no per-request data of its
// own to load server-side (GigBrowse runs the client-SDK query itself; see
// its own comment for why that's the provable shape under firestore.rules).
//
// Sub-project 9A task 8: standalone route, same as /sign-in and /join.
//
// Post-launch review fix: AppShell now wraps /gigs (see src/shell/
// AppShell.tsx's SHELL_PREFIXES comment), so signed-in primary nav stays
// inside the shell here too, and the shell already renders both its own
// "&larr; GateKeep" brand mark (plus a "Sign in" link for a signed-out
// visitor, same fallback /admin already relied on pre-review) and a Footer.
// This page's own former back link and Footer duplicated those, so both are
// removed here now that the shell supplies them.
export default function GigsPage() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Find gigs</h1>
      <p className="mt-2 font-sora text-sm text-gk-muted">Open gigs looking for an act, updated as curators post them.</p>
      <div className="mt-8">
        <GigBrowse />
      </div>
    </main>
  );
}
