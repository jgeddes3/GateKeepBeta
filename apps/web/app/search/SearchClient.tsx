"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../src/auth/AuthProvider";
import { Skeleton } from "../../src/ui/skeleton";
import { SearchFaces } from "../../src/search/SearchFaces";

// Same signed-in gate shape as DiscoverClient (app/discover/DiscoverClient.tsx):
// this route has no public/SEO surface of its own, so it carries none of
// app/e/[eventId]'s server-render discipline. Split out of page.tsx (a thin
// Server Component) so the route can still export `metadata`, which a
// "use client" file cannot.
function SearchSkeleton() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 sm:py-14" role="status" aria-label="Loading">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-9 w-48" />
      <div className="mt-8 grid gap-3">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
      </div>
    </main>
  );
}

export function SearchClient() {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Carries `next` so a signed-out visitor lands back here after signing
  // in, same as DiscoverClient's own redirect; app/sign-in/page.tsx's own
  // isSafeNext validates it server-side.
  useEffect(() => { if (!loading && !user) router.replace("/sign-in?next=/search"); }, [user, loading, router]);

  if (loading || !user) return <SearchSkeleton />;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Search</h1>
      <div className="mt-8">
        <SearchFaces />
      </div>
    </main>
  );
}
