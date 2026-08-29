import type { Metadata } from "next";
import Link from "next/link";
import { GigBrowse } from "../../src/bookings/GigBrowse";
import { Footer } from "../../src/shell/Footer";

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
// AppShell deliberately does not wrap /gigs (see src/shell/AppShell.tsx's
// SHELL_PREFIXES comment: it's a public browse page with its own anatomy,
// spec section 6.3), so this page carries its own back link and Footer.
export default function GigsPage() {
  return (
    <>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
        <Link href="/" className="font-sora text-sm text-gk-muted hover:text-gk-text">
          &larr; GateKeep
        </Link>
        <h1 className="mt-4 font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Find gigs</h1>
        <p className="mt-2 font-sora text-sm text-gk-muted">Open gigs looking for an act, updated as curators post them.</p>
        <div className="mt-8">
          <GigBrowse />
        </div>
      </main>
      <Footer />
    </>
  );
}
