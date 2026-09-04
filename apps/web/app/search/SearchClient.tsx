"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import type { SavedSearchDoc, SearchFace, SearchFilters } from "@gatekeep/shared";
import { useAuth } from "../../src/auth/AuthProvider";
import { getFirebase } from "../../src/lib/firebase";
import { Skeleton } from "../../src/ui/skeleton";
import { SearchFaces } from "../../src/search/SearchFaces";

type Initial = { face: SearchFace; q: string; filters: SearchFilters };

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

// The actual body, split out of SearchClient below: useSearchParams() reads
// the URL's query string, and Next 16 requires a client component that
// calls it to sit inside a Suspense boundary on a statically built page
// (the build fails otherwise). SearchClient itself supplies that boundary,
// so this is the only thing inside it.
function SearchBody() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const savedId = searchParams.get("saved");

  // Render-time reset (the same synchronous-during-render idiom
  // useSearch.ts's own trackedKey reset uses, not a setState call inside a
  // useEffect body): the moment `saved` itself changes (a fresh /search
  // visit, or the SavedSearches "Open" link swapping ?saved= while already
  // on this route) this drops the previous doc and flips back to loading
  // before the effect below even runs, rather than briefly rendering
  // SearchFaces with the PREVIOUS saved search's initial value.
  const [trackedSavedId, setTrackedSavedId] = useState(savedId);
  const [initial, setInitial] = useState<Initial | null>(null);
  const [initialLoading, setInitialLoading] = useState(savedId !== null);
  if (savedId !== trackedSavedId) {
    setTrackedSavedId(savedId);
    setInitial(null);
    setInitialLoading(savedId !== null);
  }

  useEffect(() => { if (!loading && !user) router.replace("/sign-in?next=/search"); }, [user, loading, router]);

  // Owner-read: savedSearches' rules only allow the doc's own uid to read
  // it, so this waits for `user` before fetching rather than racing an
  // anonymous request that would only fail.
  useEffect(() => {
    if (!savedId || !user) return;
    let cancelled = false;
    getDoc(doc(getFirebase().db, "savedSearches", savedId))
      .then((snap) => {
        if (cancelled) return;
        if (snap.exists()) {
          const d = snap.data() as SavedSearchDoc;
          setInitial({ face: d.face, q: d.q, filters: d.filters });
        } else {
          setInitial(null);
        }
        setInitialLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setInitial(null);
        setInitialLoading(false);
      });
    return () => { cancelled = true; };
  }, [savedId, user]);

  if (loading || !user || initialLoading) return <SearchSkeleton />;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Search</h1>
      <div className="mt-8">
        <SearchFaces initial={initial ?? undefined} />
      </div>
    </main>
  );
}

export function SearchClient() {
  return (
    <Suspense fallback={<SearchSkeleton />}>
      <SearchBody />
    </Suspense>
  );
}
