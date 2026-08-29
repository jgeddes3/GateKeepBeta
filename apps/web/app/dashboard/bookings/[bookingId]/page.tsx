"use client";
import { use, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "../../../../src/auth/AuthProvider";
import { BookingThread } from "../../../../src/bookings/BookingThread";
import { PaymentsPanel } from "../../../../src/payments/PaymentsPanel";
import { Skeleton } from "../../../../src/ui/skeleton";

// The booking thread screen: deep-linked from both dashboards' inbox
// sections (src/bookings/BookingInbox.tsx's BookingInbox) and from
// notification rows (kind:"booking" rows in app/dashboard/page.tsx's
// NotificationsList, via NotificationDoc.refId, Task 10a's plumbing).

function AuthSkeleton() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14" role="status" aria-label="Loading">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-9 w-2/3" />
    </main>
  );
}

export default function BookingThreadPage(props: { params: Promise<{ bookingId: string }> }) {
  const { bookingId } = use(props.params); // client components unwrap params with use()
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  if (loading || !user) return <AuthSkeleton />;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <Link href="/dashboard" className="font-sora text-sm text-gk-muted hover:text-gk-text">
        &larr; Dashboard
      </Link>
      {/* Keyed by bookingId+uid: forces a fresh BookingThread instance (all
          its per-action busy/error/dialog state resets to defaults) on
          either a route change to a different booking or a signed-in
          identity switch: mirrors the gig detail page's ApplyPanel
          key={user.uid} rationale, extended to also cover navigating
          between two DIFFERENT booking threads without an intervening
          unmount (Next.js reuses this same page component instance across
          client-side navigations to the same route with different params). */}
      <div className="mt-6">
        <BookingThread key={`${bookingId}-${user.uid}`} bookingId={bookingId} uid={user.uid} />
      </div>
      {/* Self-contained SP5 money surface: subscribes to its own
          bookings/{id} + payments data and renders nothing until the accept
          saga has staged the payments subcollection; both sides mount it,
          it renders side-appropriately. Keyed the same as BookingThread
          above, for the identical reset-on-route-or-identity-change reason. */}
      <PaymentsPanel key={`payments-${bookingId}-${user.uid}`} bookingId={bookingId} uid={user.uid} />
    </main>
  );
}
