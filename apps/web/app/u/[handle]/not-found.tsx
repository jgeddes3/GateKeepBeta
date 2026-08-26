import type { Metadata } from "next";
import styles from "./portfolio.module.css";

// Rendered when loadProfile() returns null and the page calls notFound() —
// handle doesn't exist, the profile isn't approved, or it's not a musician
// profile. Deliberately generic: never confirms or denies that a draft
// exists at this handle. Next auto-injects <meta name="robots" content="noindex">
// for any notFound()-triggered render, so that doesn't need repeating here —
// but the title does: this segment's own metadata is what actually renders,
// not generateMetadata's return value in page.tsx (that's already unmounted
// once notFound() throws).
export const metadata: Metadata = { title: "Not found · GateKeep" };

export default function NotFound() {
  return (
    <main className={styles.page}>
      <h1>Not found</h1>
      <p>No profile at that handle.</p>
    </main>
  );
}
