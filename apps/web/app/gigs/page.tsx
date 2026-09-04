import type { Metadata } from "next";
import { GigsClient } from "./GigsClient";

export const metadata: Metadata = {
  title: "Find gigs · GateKeep",
  description: "Browse open gigs looking for an act.",
};

// Thin server wrapper (metadata only) around the interactive client
// component: mirrors app/u/[handle]/page.tsx's split between page.tsx and
// its content component, though this page has no per-request data of its
// own to load server-side (GigsClient's MusicianFace runs the search
// callable itself, gated server-side by firestore.rules' access to the
// search function rather than a Firestore read this page could prove).
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
//
// Sub-project 8 task 9: the old client-side Firestore browse query is gone;
// GigsClient renders the Gigs|Venues search faces (MusicianFace) instead,
// with real server-side search, filters, and pagination.
export default function GigsPage() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Find gigs</h1>
      <p className="mt-2 font-sora text-sm text-gk-muted">Open gigs and the venues that book them, searchable.</p>
      <div className="mt-8">
        <GigsClient />
      </div>
    </main>
  );
}
