"use client";
import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "../../../src/auth/AuthProvider";
import { useMyProfiles } from "../../../src/shell/useMyProfiles";
import { EventsManager } from "../../../src/events/EventsManager";
import { Button } from "../../../src/ui/button";
import { Skeleton } from "../../../src/ui/skeleton";
import { IconEvents } from "../../../src/ui/icons";

// Sub-project 6 task 10: the curator events management page. Same "one
// route, one EventsManager per curator profile the account belongs to"
// shape app/dashboard/earnings/page.tsx already establishes for
// EarningsPanel (see that page's own MusicianProfilesList): no [profileId]
// route segment (the brief's own Files: list names exactly one page.tsx),
// since a curator with two-plus curator profiles (rare, but the same shape
// Dashboard's own multi-profile handling already assumes) manages every one
// of them from this single page rather than picking one first.
function EventsPageSkeleton() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14" role="status" aria-label="Loading">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-9 w-48" />
      <div className="mt-8 grid gap-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </main>
  );
}

export default function EventsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const profiles = useMyProfiles(user?.uid ?? null);
  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  if (loading || !user) return <EventsPageSkeleton />;

  const curatorProfiles = profiles.filter((p) => p.type === "curator");

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Events</h1>
      <p className="mt-2 font-sora text-sm text-gk-muted">Create, publish, and manage ticketed events for your venue.</p>

      <div className="mt-8 grid gap-10">
        {curatorProfiles.length === 0 ? (
          <div className="rounded-gk border border-gk-border bg-gk-surface px-6 py-10 text-center">
            <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
              <IconEvents size={20} aria-hidden="true" />
            </span>
            <p className="mt-3 font-syne text-base font-semibold text-gk-text">No curator profiles yet</p>
            <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
              Events belong to a curator profile (a venue, planner, or host). Set one up to start ticketing.
            </p>
            <Button asChild className="mt-4"><Link href="/join">Create a profile</Link></Button>
          </div>
        ) : (
          curatorProfiles.map((p) => <EventsManager key={p.profileId} profileId={p.profileId} name={p.name} />)
        )}
      </div>
    </main>
  );
}
