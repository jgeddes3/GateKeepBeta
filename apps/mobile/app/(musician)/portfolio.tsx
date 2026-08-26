import { useEffect, useState } from "react";
import { ScrollView, View, Text, Pressable, Alert, Linking } from "react-native";
import { useRouter } from "expo-router";
import { doc, onSnapshot, getDoc, collection, query, orderBy } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import { useProfileContext } from "../../src/shell/ProfileContext";
import { BioGenresForm, LinksForm, PhotoUploader, BookingForm } from "../../src/portfolio/PortfolioForms";
import { TrackManager } from "../../src/portfolio/TrackManager";
import type { ProfileDoc, BookingDoc, TrackDoc } from "@gatekeep/shared";

type TrackRow = TrackDoc & { id: string };

// Placeholder host until a deployed web domain exists — swap this one
// constant when it does; every public-page link on this screen reads it.
const PUBLIC_PROFILE_HOST = "https://gatekeep.example";

// Mirrors functions/src/profiles.ts's submitProfileForReview gate EXACTLY:
// bio, >=1 genre, an avatar photo, AND >=1 track that's actually listenable
// (status pending_review or approved) — see the server's
// LISTENABLE_TRACK_STATUSES, which excludes "processing" because createTrack
// writes the doc BEFORE the client finishes uploading bytes, so "processing"
// can be an abandoned upload with nothing behind it. Keep this in sync with
// web's Task 11 copy (apps/web/app/dashboard/portfolio/[profileId]/page.tsx)
// — a lock that's looser on one platform than the other means musicians get
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
      ? "a track that's finished processing (still transcoding — this can take a minute)"
      : "at least one track");
  }
  return missing;
}

export default function Portfolio() {
  const { user } = useAuth();
  const router = useRouter();
  const { activeContext, switchTo } = useProfileContext();
  const profileId = typeof activeContext === "object" && activeContext.type === "musician"
    ? activeContext.profileId : null;
  const [profile, setProfile] = useState<ProfileDoc | null>(null);
  const [booking, setBooking] = useState<BookingDoc | null>(null);
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    if (!profileId) { setProfile(null); return; }
    const { db } = getFirebase();
    const unsub = onSnapshot(doc(db, "profiles", profileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null));
    void getDoc(doc(db, `profiles/${profileId}/private/booking`))
      .then((s) => setBooking(s.exists() ? (s.data() as BookingDoc) : null)).catch(() => {});
    return unsub;
  }, [profileId]);

  // Own subscription, separate from TrackManager's below: the submit-lock
  // gate needs live track statuses at THIS level (to enable/disable the
  // submit button and render the missing-items hint) independent of
  // TrackManager's own list UI — catching a track's status leaving
  // "processing" without polling.
  useEffect(() => {
    if (!profileId) { setTracks([]); return; }
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, `profiles/${profileId}/tracks`), orderBy("order")),
      (s) => setTracks(s.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) }))));
  }, [profileId]);

  if (!user || !profileId || !profile) {
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text>Switch to a musician profile to edit its portfolio.</Text></View>;
  }

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
      Alert.alert("Not yet", e instanceof Error ? e.message : "Could not submit.");
    } finally {
      setSubmitBusy(false);
    }
  };

  const doDelete = async () => {
    setDeleteBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "deleteProfile")({ profileId });
      // Nothing here nulls activeContext itself — fall back to "fan" (the
      // same switch ContextSwitcher's own "Me (fan)" row performs) so this
      // screen doesn't keep pointing at a profile that no longer exists.
      switchTo("fan");
      router.replace("/(fan)");
    } catch (e) {
      Alert.alert("Could not delete", e instanceof Error ? e.message : "Try again.");
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
    <ScrollView contentContainerStyle={{ padding: 16, gap: 24 }} keyboardShouldPersistTaps="handled">
      <Text style={{ fontSize: 22, fontWeight: "700" }}>{profile.name}</Text>
      <Text>Status: {profile.status.replace("_", " ")}</Text>
      {profile.status === "approved" && (
        <Pressable onPress={() => void Linking.openURL(`${PUBLIC_PROFILE_HOST}/@${profile.handle}`)}>
          <Text style={{ textDecorationLine: "underline" }}>View public page</Text>
        </Pressable>
      )}
      {profile.status === "rejected" && (
        <View style={{ backgroundColor: "#fee2e2", borderRadius: 8, padding: 12, gap: 8 }}>
          <Text>
            <Text style={{ fontWeight: "700" }}>Changes requested: </Text>
            {profile.rejectionReason ?? "(no reason provided)"}
          </Text>
        </View>
      )}
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: "700" }}>Photos</Text>
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
      {/* only seeds its local state from `initial` once, on mount — without */}
      {/* the key forcing a remount, the PREVIOUS profile's bio/links/rates */}
      {/* would leak onto the newly-selected profile. */}
      <BioGenresForm key={profileId} profileId={profileId} initial={profile.portfolio} />
      <LinksForm key={profileId} profileId={profileId} initial={profile.portfolio} />
      <TrackManager profileId={profileId} />
      <BookingForm key={profileId} profileId={profileId} initial={booking} />
      {showSubmit && (
        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: "#eee", paddingTop: 16 }}>
          <Pressable onPress={() => void submit()} disabled={!canSubmit || submitBusy}
            style={{ backgroundColor: "#111", padding: 14, borderRadius: 8, opacity: !canSubmit || submitBusy ? 0.5 : 1 }}>
            <Text style={{ color: "#fff", textAlign: "center" }}>
              {submitBusy ? "Submitting…" : profile.status === "rejected" ? "Resubmit for review" : "Submit for review"}
            </Text>
          </Pressable>
          {!canSubmit && (
            // Plain join, not Intl.ListFormat: unverified under Hermes's ICU
            // data build — see Task 14's DO-NOT-COPY note (web's page uses
            // Intl.ListFormat; this is the deliberately simpler mobile copy).
            <Text style={{ color: "#92400e" }}>Add {missing.join(", ")} before submitting.</Text>
          )}
          <Pressable onPress={deleteDraft} disabled={deleteBusy}
            style={{ borderWidth: 1, borderColor: "#fca5a5", borderRadius: 6, padding: 10, alignSelf: "flex-start" }}>
            <Text style={{ color: "#dc2626" }}>{deleteBusy ? "Deleting…" : "Delete this profile"}</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}
