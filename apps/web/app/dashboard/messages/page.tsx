"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "../../../src/auth/AuthProvider";
import { useMyProfilesState } from "../../../src/shell/useMyProfiles";
import { useProfileRole } from "../../../src/payments/useProfileRole";
import { useOtherProfileForConversation, parsePairId } from "../../../src/messaging/useConversations";
import { ConversationList } from "../../../src/messaging/ConversationList";
import { ConversationThread } from "../../../src/messaging/ConversationThread";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../src/ui/select";
import { Button } from "../../../src/ui/button";
import { Skeleton } from "../../../src/ui/skeleton";
import { ListError } from "../../../src/ui/ListError";
import { cn } from "../../../src/lib/utils";

// Task 6: the web Messages page (spec 3.1). Fully client, same signed-in
// gate shape as app/tickets/page.tsx (no public/SEO surface here). Split
// into a Suspense-wrapped body because useSearchParams() needs one on a
// statically built page (the build fails otherwise) - the same shape
// app/search/SearchClient.tsx already uses for its own query-string reads.
function MessagesPageSkeleton() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6 sm:py-14" role="status" aria-label="Loading">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-9 w-48" />
      <div className="mt-8 grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </main>
  );
}

function MessagesBody() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("c");
  const { profiles, loaded, error: profilesError, retry: retryProfiles } = useMyProfilesState(user?.uid ?? null);

  // Only an approved musician or curator profile can send a message
  // (messaging.ts's own resolvePair gate); a draft/pending/rejected profile
  // is not offered as an acting identity here at all.
  const approvedProfiles = profiles.filter((p) => p.status === "approved" && (p.type === "musician" || p.type === "curator"));
  // "Stored in component state only" (the brief's own words): no effect
  // resets this on identity change, it is simply re-derived every render,
  // so a chosen id that no longer names an approved profile (or hasn't
  // been chosen yet) always falls back to the first approved profile.
  const [chosenProfileId, setChosenProfileId] = useState<string | null>(null);
  // Fix round, Important finding #2: a `?c=` deep link (a notification, or
  // Task 7's MessageButton) can name the user's OTHER profile, not
  // approvedProfiles[0] - a curator getting a notification about a message
  // to their musician profile, say. Only applies while nothing has been
  // explicitly chosen via "Messaging as" (`chosenProfileId` still wins once
  // set, exactly as before): the pair is parsed with the same
  // useConversations.ts's own parsePairId useOtherProfileForConversation
  // already uses, and whichever side of it names a profile this account
  // actually holds becomes the default, so the thread renders immediately
  // instead of "This conversation isn't available." until a manual switch.
  const pair = selectedId ? parsePairId(selectedId) : null;
  const pairProfileId = pair
    ? (approvedProfiles.find((p) => p.profileId === pair.musicianProfileId || p.profileId === pair.curatorProfileId)?.profileId ?? null)
    : null;
  const actingProfileId = (chosenProfileId && approvedProfiles.some((p) => p.profileId === chosenProfileId))
    ? chosenProfileId
    : (pairProfileId ?? approvedProfiles[0]?.profileId ?? null);

  const isAdmin = useProfileRole(actingProfileId ?? undefined, user?.uid) === "admin";
  const otherProfile = useOtherProfileForConversation(selectedId, actingProfileId);

  const onSelect = (id: string) => router.replace(`/dashboard/messages?c=${id}`, { scroll: false });
  const clearSelection = () => router.replace("/dashboard/messages", { scroll: false });

  useEffect(() => { if (!loading && !user) router.replace("/sign-in?next=/dashboard/messages"); }, [user, loading, router]);

  if (loading || !user || !loaded) return <MessagesPageSkeleton />;

  // Fix round, Important finding #4: useMyProfilesState's own members-read
  // listener now surfaces a failed read as a real error state (previously
  // no error callback at all: a permanent skeleton). `loaded` is already
  // true by the time `error` can be true (the hook sets both together), so
  // this is checked right after the loading gate above, before the
  // approvedProfiles-empty branch below, which a stale [] from the failed
  // read would otherwise satisfy and render the wrong "set one up" message.
  if (profilesError) {
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Messages</h1>
        <div className="mt-6">
          <ListError message="Couldn't load your profiles." onRetry={retryProfiles} />
        </div>
      </main>
    );
  }

  if (approvedProfiles.length === 0) {
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Messages</h1>
        <p className="mt-6 rounded-gk border border-gk-border bg-gk-surface px-3.5 py-2.5 font-sora text-sm text-gk-muted">
          Messages are for musician and curator profiles. Set one up from your dashboard.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Messages</h1>

      {approvedProfiles.length > 1 && (
        <div className="mt-4 grid w-fit gap-1">
          <label htmlFor="messaging-as-trigger" className="font-sora text-xs font-medium text-gk-muted">Messaging as</label>
          <Select value={actingProfileId ?? undefined} onValueChange={setChosenProfileId}>
            <SelectTrigger id="messaging-as-trigger"><SelectValue /></SelectTrigger>
            <SelectContent>
              {approvedProfiles.map((p) => (
                <SelectItem key={p.profileId} value={p.profileId}>
                  {p.name} ({p.type === "curator" ? "Curator" : "Musician"})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className={cn(selectedId ? "hidden md:block" : "block")}>
          <ConversationList profileId={actingProfileId} selectedId={selectedId} onSelect={onSelect} />
        </div>
        <div className={cn(selectedId ? "block" : "hidden md:block")}>
          {selectedId && actingProfileId ? (
            <div className="grid gap-3">
              <Button type="button" variant="ghost" className="w-fit md:hidden" onClick={clearSelection}>
                Back to conversations
              </Button>
              {/* Keyed by conversation + acting profile, the same idiom
                  BookingThread's own mount comment explains: an identity or
                  route switch always gets a fresh instance rather than
                  reusing stale per-action state (block override, composer
                  text, report dialog) under new params. */}
              <ConversationThread
                key={`${selectedId}-${actingProfileId}`}
                profileId={actingProfileId}
                conversationId={selectedId}
                otherProfile={otherProfile}
                isAdminOfProfile={isAdmin}
              />
            </div>
          ) : (
            <p className="font-sora text-sm text-gk-muted">Select a conversation to read it.</p>
          )}
        </div>
      </div>
    </main>
  );
}

export default function MessagesPage() {
  return (
    <Suspense fallback={<MessagesPageSkeleton />}>
      <MessagesBody />
    </Suspense>
  );
}
