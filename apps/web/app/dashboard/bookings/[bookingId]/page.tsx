"use client";
import { use, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "../../../../src/auth/AuthProvider";
import { BookingThread } from "../../../../src/bookings/BookingThread";

// The booking thread screen — deep-linked from both dashboards' inbox
// sections (src/bookings/BookingInbox.tsx's BookingInbox) and from
// notification rows (kind:"booking" rows in app/dashboard/page.tsx's
// NotificationsList, via NotificationDoc.refId — Task 10a's plumbing).
export default function BookingThreadPage(props: { params: Promise<{ bookingId: string }> }) {
  const { bookingId } = use(props.params); // client components unwrap params with use()
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  if (loading || !user) return <main><p>Loading…</p></main>;

  return (
    <main style={{ maxWidth: 760, margin: "40px auto", display: "grid", gap: 20 }}>
      <Link href="/dashboard" style={{ color: "#666", fontSize: 14 }}>← Dashboard</Link>
      {/* Keyed by bookingId+uid: forces a fresh BookingThread instance (all
          its per-action busy/error/dialog state resets to defaults) on
          either a route change to a different booking or a signed-in
          identity switch — mirrors the gig detail page's ApplyPanel
          key={user.uid} rationale, extended to also cover navigating
          between two DIFFERENT booking threads without an intervening
          unmount (Next.js reuses this same page component instance across
          client-side navigations to the same route with different params). */}
      <BookingThread key={`${bookingId}-${user.uid}`} bookingId={bookingId} uid={user.uid} />
    </main>
  );
}
