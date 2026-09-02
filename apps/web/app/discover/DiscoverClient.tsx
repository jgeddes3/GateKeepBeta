"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../src/auth/AuthProvider";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../src/ui/tabs";
import { Skeleton } from "../../src/ui/skeleton";
import { ShowsList } from "../../src/discover/ShowsList";
import { ArtistsList } from "../../src/discover/ArtistsList";
import { GenrePicker, useGenrePickerGate } from "../../src/discover/GenrePicker";

// Same signed-in gate shape as app/tickets/page.tsx: this route has no
// public/SEO surface of its own (a signed-out visitor has nothing to see
// here), so it carries none of app/e/[eventId]'s server-render discipline.
// Split out of page.tsx (a thin Server Component) so the route can still
// export `metadata`, which a "use client" file cannot.
function DiscoverSkeleton() {
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

export function DiscoverClient() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const gate = useGenrePickerGate(user?.uid ?? null);
  // Once dismissed (Skip, Done, or Escape/overlay, all routed through
  // GenrePicker's own dismiss handler), the dialog stays closed for the
  // rest of this mount even if the gate's own data hasn't caught up yet
  // (seenAt was read once via getDoc, not a live subscription): otherwise
  // there is a window, between the callable resolving and this component
  // noticing, where the dialog would still read as "should show".
  const [dismissedPicker, setDismissedPicker] = useState(false);

  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);

  if (loading || !user) return <DiscoverSkeleton />;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Discover</h1>
      <div className="mt-8">
        <Tabs defaultValue="shows">
          <TabsList>
            <TabsTrigger value="shows">Shows</TabsTrigger>
            <TabsTrigger value="artists">Artists</TabsTrigger>
          </TabsList>
          <TabsContent value="shows"><ShowsList /></TabsContent>
          <TabsContent value="artists"><ArtistsList /></TabsContent>
        </Tabs>
      </div>
      <GenrePicker open={gate.shouldShow && !dismissedPicker} onClose={() => setDismissedPicker(true)} />
    </main>
  );
}
