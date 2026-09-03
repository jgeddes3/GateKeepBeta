"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { doc, onSnapshot, getDoc, collection, query, orderBy } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../../../src/lib/firebase";
import { useAuth } from "../../../../src/auth/AuthProvider";
import { BioGenresForm, LinksForm, PhotoUploader, BookingForm } from "../../../../src/portfolio/PortfolioForms";
import { TrackManager } from "../../../../src/portfolio/TrackManager";
import { BookingInbox } from "../../../../src/bookings/BookingInbox";
import type { ProfileDoc, ProfileStatus, BookingDoc, TrackDoc } from "@gatekeep/shared";
import { Button } from "../../../../src/ui/button";
import { Card, CardContent } from "../../../../src/ui/card";
import { Badge } from "../../../../src/ui/badge";
import { Skeleton } from "../../../../src/ui/skeleton";
import { IconWarning } from "../../../../src/ui/icons";

type TrackRow = TrackDoc & { id: string };

// Same status -> tint mapping as the dashboard's profile cards (dashboard/page.tsx):
// draft has no strong tint (it isn't a review outcome yet), the other three map onto
// DESIGN.md's success/warning/destructive status-tint family. Exhaustive over
// ProfileStatus, so the header badge always reads a real state.
const STATUS_BADGE: Record<ProfileStatus, { variant: "secondary" | "warning" | "success" | "destructive"; label: string }> = {
  draft: { variant: "secondary", label: "Draft" },
  pending_review: { variant: "warning", label: "Pending review" },
  approved: { variant: "success", label: "Approved" },
  rejected: { variant: "destructive", label: "Rejected" },
};

// Mirrors functions/src/profiles.ts's submitProfileForReview gate EXACTLY:
// bio, >=1 genre, an avatar photo, AND >=1 track that's actually listenable
// (status pending_review or approved). A still-transcoding "processing"
// track deliberately does NOT count, see the server's
// LISTENABLE_TRACK_STATUSES, which excludes it because createTrack writes
// the doc before the client finishes uploading bytes, so "processing" can
// be an abandoned upload with nothing behind it. Getting this out of sync
// with the server is a real UX bug in either direction: locking on
// "processing" alone lets the button unlock before there's anything to
// review; not checking tracks at all leaves it clickable through a doomed
// submit with no feedback until the round-trip fails.
function missingForSubmit(profile: ProfileDoc, tracks: TrackRow[]): string[] {
  const missing: string[] = [];
  const pf = profile.portfolio;
  if (!pf?.bio?.trim()) missing.push("a bio");
  if (!pf?.genres?.length) missing.push("at least one genre");
  if (!pf?.avatarPhotoPath) missing.push("a profile photo");
  const hasListenableTrack = tracks.some((t) => t.status === "pending_review" || t.status === "approved");
  if (!hasListenableTrack) {
    missing.push(tracks.some((t) => t.status === "processing")
      ? "a track that's finished processing (still transcoding, this can take a minute)"
      : "at least one track");
  }
  return missing;
}

function EditorSkeleton() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <Skeleton className="h-4 w-24" />
      <div className="mt-4 flex items-center gap-3">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
      <div className="mt-8 grid gap-6" role="status" aria-label="Loading your portfolio">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-gk border border-gk-border bg-gk-surface p-6">
            <Skeleton className="h-5 w-32" />
            <div className="mt-4 space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

export default function PortfolioEditor(props: { params: Promise<{ profileId: string }> }) {
  const { profileId } = use(props.params); // client components unwrap params with use()
  const { user, loading } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileDoc | null | "loading">("loading");
  const [booking, setBooking] = useState<BookingDoc | null | "loading">("loading");
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Resets `booking` back to "loading" the instant profileId changes: an
  // in-app navigation from profile A's editor to profile B's (same
  // route/component, different params) does NOT remount this page, so
  // without this, B's first render(s) would show A's still-cached booking
  // data. Adjusted during render (React's documented pattern for resetting
  // state when a prop/param changes: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes),
  // not in a useEffect: this runs synchronously before commit, so React
  // re-renders once more with the reset state instead of painting a stale
  // frame first.
  const [bookingProfileId, setBookingProfileId] = useState(profileId);
  if (profileId !== bookingProfileId) {
    setBookingProfileId(profileId);
    setBooking("loading");
  }

  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    const unsub = onSnapshot(doc(db, "profiles", profileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null),
      () => setProfile(null));
    // `cancelled` guards against a stale WRITE (as opposed to the stale
    // READ the render-time reset above handles): without it, navigating
    // from profile A's editor to profile B's can let A's getDoc resolve
    // AFTER B's effect has already started, overwriting B's freshly-reset
    // booking state with A's data.
    let cancelled = false;
    void getDoc(doc(db, `profiles/${profileId}/private/booking`))
      .then((s) => { if (!cancelled) setBooking(s.exists() ? (s.data() as BookingDoc) : null); })
      .catch(() => { if (!cancelled) setBooking(null); });
    return () => { cancelled = true; unsub(); };
  }, [user, profileId]);
  // Own subscription, separate from TrackManager's below: the submit-lock
  // gate below needs live track statuses at THIS level (to enable/disable
  // the button and render the missing-items hint) independent of
  // TrackManager's own list UI, listening for a track's status leaving
  // "processing" without polling.
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, `profiles/${profileId}/tracks`), orderBy("order")),
      (s) => setTracks(s.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) }))));
  }, [user, profileId]);

  // `booking === "loading"` is load-bearing here, not just a nicety. When
  // profileId changes, the render-time reset above only resets `booking`:
  // `profile` and `tracks` still hold profile A's data until their new
  // subscriptions deliver B's. This early return is what keeps that stale
  // state off the screen (and out of the forms) during that window; drop it
  // and A's rates/bio/tracks render under B's route params until B's
  // snapshots land. (React re-renders before committing after a render-phase
  // setState, so the reset itself is never committed stale: the gap is the
  // un-reset profile/tracks state, not the reset mechanism.)
  if (loading || !user || profile === "loading" || booking === "loading") return <EditorSkeleton />;
  if (!profile || profile.type !== "musician") {
    return (
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16 text-center sm:px-6">
        <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
          <IconWarning size={20} aria-hidden="true" />
        </span>
        <p className="mt-3 font-syne text-lg font-semibold text-gk-text">No musician profile here</p>
        <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
          This profile doesn&apos;t exist, or it isn&apos;t a musician profile tied to your account.
        </p>
        <Button asChild className="mt-4">
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      </main>
    );
  }

  const missing = missingForSubmit(profile, tracks);
  const canSubmit = missing.length === 0;
  const showSubmit = profile.status === "draft" || profile.status === "rejected";
  const status = STATUS_BADGE[profile.status];

  const submit = async () => {
    setSubmitBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "submitProfileForReview")({ profileId });
    } catch (e) {
      // The server's failed-precondition message is user-ready, surface it
      // verbatim. This is the backstop for a race the client gate's snapshot
      // hasn't caught up to yet (e.g. a track flips out of pending_review
      // between renders), not the primary UX (the button is disabled while
      // `missing` is non-empty).
      window.alert(e instanceof Error ? e.message : "Could not submit.");
    } finally {
      setSubmitBusy(false);
    }
  };

  const deleteDraft = async () => {
    const ok = window.confirm(
      `Delete "${profile.name}"? This permanently deletes the profile, its tracks, and its photos, ` +
      `and releases the handle @${profile.handle}. This can't be undone.`);
    if (!ok) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await httpsCallable(getFirebase().functions, "deleteProfile")({ profileId });
      router.push("/dashboard");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Could not delete this profile.");
      setDeleteBusy(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <Link href="/dashboard" className="font-sora text-sm text-gk-muted hover:text-gk-text">
        &larr; Dashboard
      </Link>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">{profile.name}</h1>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      {profile.status === "approved" && (
        <Button asChild variant="link" className="mt-1 h-auto p-0">
          <a href={`/@${profile.handle}`} target="_blank" rel="noopener noreferrer">View public page</a>
        </Button>
      )}
      {profile.status === "rejected" && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-gk border border-gk-destructive/40 bg-gk-destructive/14 px-3.5 py-2.5 font-sora text-sm text-gk-destructive"
        >
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p><span className="font-semibold">Changes requested.</span> {profile.rejectionReason ?? "No reason provided."}</p>
        </div>
      )}

      <div className="mt-8 grid gap-6">
        <section>
          <h2 className="font-syne text-lg font-semibold text-gk-text">Photos</h2>
          <Card className="mt-3">
            <CardContent className="flex flex-wrap gap-6">
              <div className="grid gap-1.5">
                <PhotoUploader
                  profileId={profileId}
                  uid={user.uid}
                  kind="avatar"
                  currentPath={profile.portfolio?.avatarPhotoPath ?? null}
                />
                <span className="font-sora text-xs text-gk-muted">Profile photo</span>
              </div>
              <div className="grid gap-1.5">
                <PhotoUploader
                  profileId={profileId}
                  uid={user.uid}
                  kind="cover"
                  currentPath={profile.portfolio?.coverPhotoPath ?? null}
                />
                <span className="font-sora text-xs text-gk-muted">Cover photo</span>
              </div>
            </CardContent>
          </Card>
          <p className="mt-2 font-sora text-xs text-gk-muted">Photos appear on your page a few seconds after upload.</p>
        </section>

        {/* Keyed by profileId: these forms seed their local state from
            `initial` only once, on mount (see PortfolioForms.tsx). Without the
            key, an in-app navigation from one profile's editor to another's
            (same route/component, different params) would reuse these
            instances and leave the FIRST profile's bio/links/rates showing,
            and editable, on top of the second profile's data until a full
            reload. */}
        <BioGenresForm key={profileId} profileId={profileId} initial={profile.portfolio} />
        <LinksForm key={profileId} profileId={profileId} initial={profile.portfolio} />
        <TrackManager profileId={profileId} />
        <BookingForm key={profileId} profileId={profileId} initial={booking} />

        {profile.status === "approved" && (
          // Only an approved musician profile can have bookings at all
          // (applyToGig/offerGig both require requireApprovedMusicianProfile),
          // a draft/pending/rejected profile's inbox would always be empty,
          // so this section is hidden rather than shown-empty until approval.
          // Keyed by profileId so switching profiles under this same route
          // resets BookingInbox's three onSnapshot subscriptions instead of
          // reusing the previous profile's listeners against new params.
          <section className="border-t border-gk-border pt-8">
            <h2 className="font-syne text-lg font-semibold text-gk-text">Bookings</h2>
            <div className="mt-3">
              <BookingInbox key={profileId} profileId={profileId} role="musician" />
            </div>
          </section>
        )}

        {showSubmit && (
          <section className="grid gap-3 border-t border-gk-border pt-8">
            <h2 className="font-syne text-lg font-semibold text-gk-text">Ready to submit?</h2>
            {!canSubmit && (
              <p className="rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
                {/* Same construction as the server's failed-precondition message
                    (functions/src/profiles.ts): "a bio, at least one genre, and
                    a profile photo" instead of a raw comma join, so the client
                    hint reads identically to what the server would say if this
                    lock were somehow bypassed. */}
                Add {new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(missing)} before submitting.
              </p>
            )}
            <Button type="button" onClick={submit} disabled={!canSubmit || submitBusy} className="justify-self-start">
              {submitBusy ? "Submitting…" : profile.status === "rejected" ? "Resubmit for review" : "Submit for review"}
            </Button>
            <Button
              type="button"
              variant="link"
              className="h-auto justify-self-start p-0 text-gk-destructive"
              onClick={deleteDraft}
              disabled={deleteBusy}
            >
              {deleteBusy ? "Deleting…" : "Delete this profile"}
            </Button>
            {deleteError && (
              <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
                <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                {deleteError}
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
