import { useEffect, useRef, useState } from "react";
import { ScrollView, View, Alert, Linking } from "react-native";
import { useRouter } from "expo-router";
import { doc, onSnapshot, getDoc, collection, query, orderBy } from "firebase/firestore";
import { getFirebase } from "../../src/lib/firebase";
import { callFn } from "../../src/lib/callable";
import { useAuth } from "../../src/auth/AuthProvider";
import { useProfileContext } from "../../src/shell/ProfileContext";
import { BioGenresForm, LinksForm, PhotoUploader, BookingForm } from "../../src/portfolio/PortfolioForms";
import { TrackManager } from "../../src/portfolio/TrackManager";
import type { ProfileDoc, BookingDoc, TrackDoc } from "@gatekeep/shared";
import { Text, Button, Callout, ErrorBanner, PageBackground, Skeleton, SkeletonCard } from "../../src/ui";
import { useTokens } from "../../src/theme/ThemeProvider";
import { tokens } from "../../src/theme/tokens";

type TrackRow = TrackDoc & { id: string };

// Placeholder host until a deployed web domain exists, swap this one
// constant when it does; every public-page link on this screen reads it.
const PUBLIC_PROFILE_HOST = "https://gatekeep.example";
// Still the placeholder above: hide the "View public page" link entirely
// rather than send an approved musician to a dead gatekeep.example URL.
// Flips on its own once PUBLIC_PROFILE_HOST is updated to the real host.
const PUBLIC_PROFILE_HOST_READY = !PUBLIC_PROFILE_HOST.includes("gatekeep.example");

// Mirrors functions/src/profiles.ts's submitProfileForReview gate EXACTLY:
// bio, >=1 genre, an avatar photo, AND >=1 track that's actually listenable
// (status pending_review or approved), see the server's
// LISTENABLE_TRACK_STATUSES, which excludes "processing" because createTrack
// writes the doc BEFORE the client finishes uploading bytes, so "processing"
// can be an abandoned upload with nothing behind it. Keep this in sync with
// web's Task 11 copy (apps/web/app/dashboard/portfolio/[profileId]/page.tsx).
// A lock that's looser on one platform than the other means musicians get
// a different (and confusing) submit experience depending which app they
// used.
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

export default function Portfolio() {
  const { user } = useAuth();
  const router = useRouter();
  const { activeContext, switchTo } = useProfileContext();
  const t = useTokens();
  const profileId = typeof activeContext === "object" && activeContext.type === "musician"
    ? activeContext.profileId : null;
  const [profile, setProfile] = useState<ProfileDoc | null>(null);
  // Four states. "loading" is load-bearing, not just a nicety: BookingForm
  // seeds its local rate inputs from `initial` on mount: if `initial` were
  // `null` for the ordinary "getDoc hasn't resolved yet" case
  // (indistinguishable from "no booking doc saved"), a musician who already
  // has saved rates would see the form mount blank, and its very next save
  // would full-document-set() all-null rates over the real ones. Silent data
  // loss. Mirrors web's Task 11 page.tsx exactly. "error" is separate from
  // `null` for the SAME reason, one level down: a getDoc that FAILED
  // (offline, a transient read error) is not "no doc exists" either, same
  // failure-vs-empty distinction as PhotoUploader's `awaiting`/timeout state
  // and TrackQueueRow's clip-URL-failed state elsewhere in this codebase.
  // Collapsing "error" into `null` would mount BookingForm blank over rates
  // that are still there server-side the read simply didn't reach.
  const [booking, setBooking] = useState<BookingDoc | null | "loading" | "error">("loading");
  // Bumped by the "Retry" row's Retry button (see the booking === "error"
  // render branch below) to force the booking effect below to re-run
  // without also needing its own separate effect.
  const [bookingRetry, setBookingRetry] = useState(0);
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Identity check for the effects below, closing a sub-frame race the
  // render-time reset alone doesn't: React runs effect CLEANUP at the
  // passive-effect flush, which happens AFTER commit and paint, not
  // synchronously during the render-time reset. That leaves a real window
  // where profile A's already-in-flight onSnapshot/getDoc callbacks can
  // still resolve and call setState AFTER the reset below has already run
  // (profileId changed to B) but BEFORE A's effect cleanup has unsubscribed
  // them. Without this check, one of those late A-callbacks repopulates the
  // just-reset state, and BookingForm ends up mounted under profile B seeded
  // with A's rates, the same silent-data-loss shape as the missing
  // sentinel above, just from a narrower window. `activeIdRef` is kept in
  // sync with whichever profileId is CURRENTLY active, updated inside the
  // render-time reset block below, and correct from the very first render
  // via useRef's initializer here, so every effect callback can check
  // "is my profileId still the active one" instead of trusting its own
  // closure (which is fixed to whichever profileId it was created under).
  const activeIdRef = useRef(profileId);

  // Render-time reset, mirroring PhotoUploader's `baseline` pattern (Task
  // 13) and web's `bookingProfileId` sentinel (Task 11): Expo Router's Tabs
  // navigator keeps this screen mounted across a profile-context switch:
  // ContextSwitcher only changes `activeContext`, it never unmounts this
  // component, exactly like Next's App Router reusing the editor page
  // across a profileId route-param change. Without this, switching from
  // musician profile A to musician profile B leaves A's profile/booking/
  // tracks state on screen (and editable, and save-able onto B) until each
  // subscription's first snapshot for B lands. Adjusted synchronously during
  // render (React's documented "adjust state while rendering" pattern:
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  // so React re-renders once more with the reset state before committing,
  // instead of painting a stale frame first.
  const [lastProfileId, setLastProfileId] = useState(profileId);
  if (profileId !== lastProfileId) {
    setLastProfileId(profileId);
    // react-hooks/refs flags any ref write during render on principle (a
    // discarded/re-run render could in general mutate a ref more than
    // once), but this particular write is idempotent, it always sets
    // activeIdRef.current to the profileId this render is FOR, so a
    // StrictMode double-render or a thrown-away render pass writes the
    // same value redundantly rather than a wrong one. It has to happen
    // HERE (synchronously, in the same render-time reset as the setState
    // calls below) rather than in an effect: see the block comment above
    // this ref's declaration for the exact race (effect cleanup runs
    // after commit+paint) this closes.
    // eslint-disable-next-line react-hooks/refs
    activeIdRef.current = profileId;
    setProfile(null);
    setBooking("loading");
    setTracks([]);
  }

  useEffect(() => {
    // profile is already null here: the render-time reset above just ran
    // (or this mounted with profileId already null, matching useState's
    // own default), no need to set it again.
    if (!profileId) return;
    // Captured once per effect instance (one per profileId, since this
    // effect is keyed on it), the identity check below compares against
    // whichever profileId is CURRENTLY active, not this closure's own,
    // fixed-at-creation value.
    const forId = profileId;
    const { db } = getFirebase();
    const unsub = onSnapshot(doc(db, "profiles", profileId),
      (s) => {
        if (activeIdRef.current !== forId) return;
        setProfile(s.exists() ? (s.data() as ProfileDoc) : null);
      },
      // A read failure (offline, a rules edge case) is treated as "gone"
      // rather than left stale, same as web's page.tsx.
      () => {
        if (activeIdRef.current !== forId) return;
        setProfile(null);
      });
    let cancelled = false;
    void getDoc(doc(db, `profiles/${profileId}/private/booking`))
      .then((s) => {
        if (cancelled || activeIdRef.current !== forId) return;
        setBooking(s.exists() ? (s.data() as BookingDoc) : null);
      })
      .catch((e) => {
        console.error("booking getDoc failed", e);
        // MUST resolve the sentinel here too, not just on success, an
        // unresolved "loading" left hanging after a failed read is exactly
        // the state BookingForm's seed-from-initial bug above needs to stay
        // safe from. "error", not `null`: see the state comment above.
        if (cancelled || activeIdRef.current !== forId) return;
        setBooking("error");
      });
    return () => { cancelled = true; unsub(); };
  }, [profileId, bookingRetry]);

  // Own subscription, separate from TrackManager's below: the submit-lock
  // gate needs live track statuses at THIS level (to enable/disable the
  // submit button and render the missing-items hint) independent of
  // TrackManager's own list UI, catching a track's status leaving
  // "processing" without polling.
  useEffect(() => {
    // Same reasoning as the profile effect above: tracks is already []
    // (render-time reset, or useState's own default) by the time this runs.
    if (!profileId) return;
    const forId = profileId;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, `profiles/${profileId}/tracks`), orderBy("order")),
      (s) => {
        if (activeIdRef.current !== forId) return;
        setTracks(s.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) })));
      },
      (e) => {
        if (activeIdRef.current !== forId) return;
        console.error("tracks onSnapshot failed", e);
      });
  }, [profileId]);

  if (!user || !profileId || !profile || booking === "loading") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        {!user || !profileId ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.sm }}>
            <Text variant="title">No musician profile</Text>
            <Text muted style={{ textAlign: "center" }}>Switch to a musician profile to edit its portfolio.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.xl }}>
            <Skeleton height={28} width="60%" />
            <Skeleton height={16} width="40%" />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </ScrollView>
        )}
      </View>
    );
  }

  const retryBooking = () => {
    setBooking("loading");
    setBookingRetry((n) => n + 1);
  };

  const missing = missingForSubmit(profile, tracks);
  const canSubmit = missing.length === 0;
  const showSubmit = profile.status === "draft" || profile.status === "rejected";

  const submit = async () => {
    setSubmitBusy(true);
    try {
      await callFn("submitProfileForReview", { profileId });
    } catch (e) {
      // The server's failed-precondition message is user-ready, surface it
      // verbatim. This is the backstop for a race the client gate's snapshot
      // hasn't caught up to yet (e.g. a track flips out of pending_review
      // between renders), not the primary UX (the button is disabled while
      // `missing` is non-empty).
      Alert.alert("Not yet", e instanceof Error ? e.message : "Could not submit.");
    } finally {
      setSubmitBusy(false);
    }
  };

  const doDelete = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await callFn("deleteProfile", { profileId });
      // Nothing here nulls activeContext itself, fall back to "fan" (the
      // same switch ContextSwitcher's own "Me (fan)" row performs) so this
      // screen doesn't keep pointing at a profile that no longer exists.
      switchTo("fan");
      router.replace("/(fan)");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Couldn't delete this profile. Try again.");
      setDeleteBusy(false);
    }
  };
  const deleteDraft = () => {
    Alert.alert(
      `Delete "${profile.name}"?`,
      `This permanently deletes the profile, its tracks, and its photos, and releases the handle @${profile.handle}. This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void doDelete() },
      ],
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.xl }} keyboardShouldPersistTaps="handled">
        <Text variant="heading">{profile.name}</Text>
        <Text variant="label" muted>Status: {profile.status.replace("_", " ")}</Text>
        {profile.status === "approved" && PUBLIC_PROFILE_HOST_READY && (
          <Button title="View public page" variant="secondary" style={{ alignSelf: "flex-start" }}
            onPress={() => void Linking.openURL(`${PUBLIC_PROFILE_HOST}/@${profile.handle}`)} />
        )}
        {profile.status === "rejected" && (
          <Callout tone="destructive" style={{ gap: tokens.space.sm }}>
            <Text variant="label">Changes requested</Text>
            <Text>{profile.rejectionReason ?? "(no reason provided)"}</Text>
          </Callout>
        )}
        <View style={{ gap: tokens.space.sm }}>
          <Text variant="title">Photos</Text>
          {/* currentPath is required, not optional: Task 13's PhotoUploader */}
          {/* watches it (against its own `baseline`) to know when the photo */}
          {/* pipeline has finished and drop its "Processing…" state. */}
          <PhotoUploader profileId={profileId} uid={user.uid} kind="avatar"
            currentPath={profile.portfolio?.avatarPhotoPath ?? null} />
          <PhotoUploader profileId={profileId} uid={user.uid} kind="cover"
            currentPath={profile.portfolio?.coverPhotoPath ?? null} />
        </View>
        {/* key={profileId} on all three initial-seeded forms: Expo Router reuses */}
        {/* this screen instance across a profile-context switch, and each form */}
        {/* only seeds its local state from `initial` once, on mount, without */}
        {/* the key forcing a remount, the PREVIOUS profile's bio/links/rates */}
        {/* would leak onto the newly-selected profile. */}
        <BioGenresForm key={profileId} profileId={profileId} initial={profile.portfolio} />
        <LinksForm key={profileId} profileId={profileId} initial={profile.portfolio} />
        <TrackManager profileId={profileId} />
        {booking === "error" ? (
          <View style={{ gap: tokens.space.sm }}>
            <Text variant="title">Rates & preferences</Text>
            {/* "error" is distinct from the ordinary null-means-"no doc yet"
                case above on purpose, same failure-vs-empty distinction as
                PhotoUploader's awaiting/timeout state and TrackQueueRow's
                clip-URL-failed state. Rendering BookingForm here with
                initial={null} would mount it blank over rates that are still
                saved server-side; the read just didn't reach them. */}
            <ErrorBanner message="Couldn't load your rates." />
            <Button title="Retry" variant="secondary" onPress={retryBooking} style={{ alignSelf: "flex-start" }} />
          </View>
        ) : (
          <BookingForm key={profileId} profileId={profileId} initial={booking} />
        )}
        {showSubmit && (
          <View style={{ gap: tokens.space.sm, borderTopWidth: 1, borderTopColor: t.border, paddingTop: tokens.space.lg }}>
            <Button
              onPress={() => void submit()}
              disabled={!canSubmit || submitBusy}
              title={submitBusy ? "Submitting…" : profile.status === "rejected" ? "Resubmit for review" : "Submit for review"}
            />
            {!canSubmit && (
              // Plain join, not Intl.ListFormat: unverified under Hermes's ICU
              // data build, see Task 14's DO-NOT-COPY note (web's page uses
              // Intl.ListFormat; this is the deliberately simpler mobile copy).
              <Text color={t.warning}>Add {missing.join(", ")} before submitting.</Text>
            )}
            <Button
              onPress={deleteDraft}
              disabled={deleteBusy}
              variant="destructive"
              style={{ alignSelf: "flex-start" }}
              title={deleteBusy ? "Deleting…" : "Delete this profile"}
            />
            <ErrorBanner message={deleteError} />
          </View>
        )}
      </ScrollView>
    </View>
  );
}
