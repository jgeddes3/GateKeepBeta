import styles from "./portfolio.module.css";

// Rendered when loadProfile() returns null and the page calls notFound() —
// handle doesn't exist, the profile isn't approved, or it's not a musician
// profile. Deliberately generic: never confirms or denies that a draft
// exists at this handle.
export default function NotFound() {
  return (
    <main className={styles.page}>
      <h1>Not found</h1>
      <p>No profile at that handle.</p>
    </main>
  );
}
