import Link from "next/link";

// Quiet single-row footer for signed-in pages (spec section 3 / section 5.6):
// only the links that actually exist. /terms and /privacy are a Task 4
// dependency (this task doesn't create them, so they 404 until then, tracked
// in the task report), and the contact address is a placeholder pending the
// owner's real support inbox, same as /terms and /privacy are placeholder
// pages until Task 4 writes them.
const CONTACT_EMAIL = "hello@gatekeep.app";

export function Footer() {
  return (
    <footer className="border-t border-gk-border">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-4 py-6 font-sora text-xs text-gk-muted sm:flex-row sm:justify-between sm:px-6">
        <p className="font-syne">GateKeep</p>
        <nav className="flex items-center gap-4">
          <Link href="/terms" className="hover:text-gk-text">Terms</Link>
          <Link href="/privacy" className="hover:text-gk-text">Privacy</Link>
          <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-gk-text">{CONTACT_EMAIL}</a>
        </nav>
      </div>
    </footer>
  );
}
