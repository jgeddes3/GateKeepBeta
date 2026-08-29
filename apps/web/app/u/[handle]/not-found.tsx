import type { Metadata } from "next";

// Rendered when loadProfile() returns null and the page calls notFound():
// handle doesn't exist, the profile isn't approved, or it's not a musician
// profile. Deliberately generic: never confirms or denies that a draft
// exists at this handle. Next auto-injects <meta name="robots" content="noindex">
// for any notFound()-triggered render, so that doesn't need repeating here,
// but the title does: this segment's own metadata is what actually renders,
// not generateMetadata's return value in page.tsx (that's already unmounted
// once notFound() throws).
//
// Sub-project 9A task 10: restyled off portfolio.module.css to gk-* tokens,
// the same trim MusicianProfile.tsx's Task 9 restyle already did for this
// route's other components. This was the module's last importer; the file
// is deleted alongside this change.
export const metadata: Metadata = { title: "Not found · GateKeep" };

export default function NotFound() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-16 text-center sm:px-6">
      <h1 className="font-syne text-2xl font-extrabold text-gk-text sm:text-3xl">Not found</h1>
      <p className="mt-2 font-sora text-sm text-gk-muted">No profile at that handle.</p>
    </main>
  );
}
