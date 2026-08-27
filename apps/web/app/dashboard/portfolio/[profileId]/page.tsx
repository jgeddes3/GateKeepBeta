"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, onSnapshot, getDoc, collection, query, orderBy } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../../../src/lib/firebase";
import { useAuth } from "../../../../src/auth/AuthProvider";
import { BioGenresForm, LinksForm, PhotoUploader, BookingForm } from "../../../../src/portfolio/PortfolioForms";
import { TrackManager } from "../../../../src/portfolio/TrackManager";
import { BookingInbox } from "../../../../src/bookings/BookingInbox";
import type { ProfileDoc, BookingDoc, TrackDoc } from "@gatekeep/shared";

type TrackRow = TrackDoc & { id: string };

// Mirrors functions/src/profiles.ts's submitProfileForReview gate EXACTLY:
// bio, >=1 genre, an avatar photo, AND >=1 track that's actually listenable
// (status pending_review or approved). A still-transcoding "processing"
// track deliberately does NOT count — see the server's
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
      ? "a track that's finished processing (still transcoding — this can take a minute)"
      : "at least one track");
  }
  return missing;
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

  // Resets `booking` back to "loading" the instant profileId changes — an
  // in-app navigation from profile A's editor to profile B's (same
  // route/component, different params) does NOT remount this page, so
  // without this, B's first render(s) would show A's still-cached booking
  // data. Adjusted during render (React's documented pattern for resetting
  // state when a prop/param changes — https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes),
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
  // TrackManager's own list UI — listening for a track's status leaving
  // "processing" without polling.
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, `profiles/${profileId}/tracks`), orderBy("order")),
      (s) => setTracks(s.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) }))));
  }, [user, profileId]);

  // `booking === "loading"` is load-bearing here, not just a nicety. When
  // profileId changes, the render-time reset above only resets `booking` —
  // `profile` and `tracks` still hold profile A's data until their new
  // subscriptions deliver B's. This early return is what keeps that stale
  // state off the screen (and out of the forms) during that window; drop it
  // and A's rates/bio/tracks render under B's route params until B's
  // snapshots land. (React re-renders before committing after a render-phase
  // setState, so the reset itself is never committed stale — the gap is the
  // un-reset profile/tracks state, not the reset mechanism.)
  if (loading || !user || profile === "loading" || booking === "loading") return <main><p>Loading…</p></main>;
  if (!profile || profile.type !== "musician") return <main><p>No musician profile here.</p></main>;

  const missing = missingForSubmit(profile, tracks);
  const canSubmit = missing.length === 0;
  const showSubmit = profile.status === "draft" || profile.status === "rejected";

  const submit = async () => {
    setSubmitBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "submitProfileForReview")({ profileId });
    } catch (e) {
      // The server's failed-precondition message is user-ready — surface it
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
    try {
      await httpsCallable(getFirebase().functions, "deleteProfile")({ profileId });
      router.push("/dashboard");
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not delete this profile.");
      setDeleteBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 760, margin: "40px auto", display: "grid", gap: 32 }}>
      <h1>{profile.name} — portfolio</h1>
      <p>
        Status: <strong>{profile.status.replace("_", " ")}</strong>
        {profile.status === "approved" && (
          <> · <a href={`/@${profile.handle}`} target="_blank" rel="noopener noreferrer">view public page</a></>
        )}
      </p>
      {profile.status === "rejected" && (
        <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, padding: 12 }}>
          <strong>Changes requested:</strong> {profile.rejectionReason ?? "(no reason provided)"}
        </div>
      )}
      <section>
        <h2>Photos</h2>
        <p>
          <PhotoUploader profileId={profileId} uid={user.uid} kind="avatar" currentPath={profile.portfolio?.avatarPhotoPath ?? null} />
          {" · "}
          <PhotoUploader profileId={profileId} uid={user.uid} kind="cover" currentPath={profile.portfolio?.coverPhotoPath ?? null} />
        </p>
        <p style={{ color: "#666" }}>Photos appear on your page a few seconds after upload.</p>
      </section>
      {/* Keyed by profileId: these forms seed their local state from `initial`
          only once, on mount (see PortfolioForms.tsx). Without the key, an
          in-app navigation from one profile's editor to another's (same
          route/component, different params) would reuse these instances and
          leave the FIRST profile's bio/links/rates showing — and editable —
          on top of the second profile's data until a full reload. */}
      <BioGenresForm key={profileId} profileId={profileId} initial={profile.portfolio} />
      <LinksForm key={profileId} profileId={profileId} initial={profile.portfolio} />
      <TrackManager profileId={profileId} />
      <BookingForm key={profileId} profileId={profileId} initial={booking} />
      {profile.status === "approved" && (
        // Only an approved musician profile can have bookings at all
        // (applyToGig/offerGig both require requireApprovedMusicianProfile)
        // — a draft/pending/rejected profile's inbox would always be empty,
        // so this section is hidden rather than shown-empty until approval.
        // Keyed by profileId so switching profiles under this same route
        // resets BookingInbox's three onSnapshot subscriptions instead of
        // reusing the previous profile's listeners against new params.
        <section style={{ borderTop: "1px solid #eee", paddingTop: 24 }}>
          <h2>Bookings</h2>
          <BookingInbox key={profileId} profileId={profileId} role="musician" />
        </section>
      )}
      {showSubmit && (
        <section style={{ display: "grid", gap: 8, borderTop: "1px solid #eee", paddingTop: 24 }}>
          <button onClick={submit} disabled={!canSubmit || submitBusy} style={{ padding: 12, fontSize: 16 }}>
            {submitBusy ? "Submitting…" : profile.status === "rejected" ? "Resubmit for review" : "Submit for review"}
          </button>
          {!canSubmit && (
            <p style={{ color: "#92400e", margin: 0 }}>
              {/* Same construction as the server's failed-precondition message
                  (functions/src/profiles.ts) — "a bio, at least one genre, and
                  a profile photo" instead of a raw comma join, so the client
                  hint reads identically to what the server would say if this
                  lock were somehow bypassed. */}
              Add {new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(missing)} before submitting.
            </p>
          )}
          <button onClick={deleteDraft} disabled={deleteBusy}
            style={{ color: "#dc2626", justifySelf: "start", background: "none", border: "1px solid #fca5a5", borderRadius: 6, padding: "6px 12px" }}>
            {deleteBusy ? "Deleting…" : "Delete this profile"}
          </button>
        </section>
      )}
    </main>
  );
}
