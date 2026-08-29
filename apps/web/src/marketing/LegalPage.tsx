import Link from "next/link";
import type { ReactNode } from "react";

// Shared shell for /terms and /privacy (spec section 5's "legal pages" /
// section 6.9): the site's real tokens (gk-surface, gk-border, Syne/Sora),
// not the app's signed-in AppShell (these are public pages reachable
// signed-out, same posture as the landing page), plus a banner that
// clearly labels the section text below as a placeholder rather than
// disguising draft copy as final legal language. flex-1 matches the
// signed-in shell's own pattern (AppShell's <div className="flex-1">) so
// the Footer, rendered by the page below this component, still sits at the
// bottom of a short viewport instead of floating right under the content.
export function LegalPage({
  title, bannerNoun, children,
}: {
  title: string;
  bannerNoun: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-16 sm:px-6 sm:py-20">
      <Link href="/" className="font-sora text-sm text-gk-muted hover:text-gk-text">
        &larr; GateKeep
      </Link>
      <h1 className="mt-6 font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">{title}</h1>
      <div className="mt-6 rounded-gk border border-gk-warning/40 bg-gk-warning/10 px-4 py-3 font-sora text-sm">
        <p className="font-semibold text-gk-text">
          Placeholder {bannerNoun}, have counsel review before launch.
        </p>
        <p className="mt-1 text-gk-muted">
          The sections below describe how GateKeep actually works today. They are draft language,
          not final legal terms, and have not been reviewed by a lawyer.
        </p>
      </div>
      <div className="mt-10 space-y-8 font-sora text-sm leading-relaxed text-gk-text">{children}</div>
    </main>
  );
}

export function LegalSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-syne text-lg font-semibold text-gk-text">{heading}</h2>
      <div className="mt-2 space-y-2 text-gk-muted">{children}</div>
    </section>
  );
}
