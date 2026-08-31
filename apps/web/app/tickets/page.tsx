"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../src/auth/AuthProvider";
import { TicketsClient } from "./TicketsClient";
import { Skeleton } from "../../src/ui/skeleton";

// Sub-project 6 task 10: the fan "Your tickets" page. Fully client, same
// signed-in gate shape as app/dashboard/page.tsx and app/dashboard/earnings/
// page.tsx (router.replace("/sign-in") once auth resolves, a skeleton while
// it does): this route has no public/SEO surface of its own (a signed-out
// visitor has nothing to see here), unlike app/e/[eventId], so it carries
// none of that page's server-render discipline.
function TicketsPageSkeleton() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14" role="status" aria-label="Loading">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-9 w-48" />
      <div className="mt-8 grid gap-3">
        {[0, 1].map((i) => <Skeleton key={i} className="h-32 w-full" />)}
      </div>
    </main>
  );
}

export default function TicketsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  if (loading || !user) return <TicketsPageSkeleton />;
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Your tickets</h1>
      <div className="mt-8">
        <TicketsClient key={`tickets-${user.uid}`} uid={user.uid} />
      </div>
    </main>
  );
}
