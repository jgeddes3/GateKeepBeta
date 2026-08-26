import { useEffect, useRef, useState } from "react";
import { ScrollView, View, Text, Pressable, Alert, Linking } from "react-native";
import { useRouter } from "expo-router";
import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import { useProfileContext } from "../../src/shell/ProfileContext";
import { AboutForm, LocationForm, LookingForForm, AmenitiesForm, GalleryPhotosSection } from "../../src/curator/CuratorForms";
import { validateLookingFor, type ProfileDoc, type CuratorDetails, type CuratorSubtype } from "@gatekeep/shared";

// This tab IS the curator wizard AND the post-approval editor — same shape
// as (musician)/portfolio.tsx and web's dashboard/curator/[profileId]/page.tsx
// "sectioned editor with gate-status" (the accepted Task 9 shape): there's no
// separate multi-step wizard screen. Every section below stays mounted and
// editable at every status; the "Ready to submit?" block only appears while
// draft/rejected.

// Placeholder host until a deployed web domain exists — mirrors
// (musician)/portfolio.tsx's identical constant/gating.
const PUBLIC_PROFILE_HOST = "https://gatekeep.example";
const PUBLIC_PROFILE_HOST_READY = !PUBLIC_PROFILE_HOST.includes("gatekeep.example");

// Mirrors functions/src/profiles.ts's submitProfileForReview curator gate
// EXACTLY: about, >=1 photo, a location (venues need a street address;
// planners/hosts a city is enough), and a valid lookingFor (validateLookingFor
// is the same shared validator the server runs). Same labels as web's
// dashboard/curator/[profileId]/page.tsx REQUIREMENTS array, so the checklist
// and hint read identically to what the server would say.
const REQUIREMENTS: { label: string; done: (c: CuratorDetails | undefined, subtype: CuratorSubtype) => boolean }[] = [
  { label: "an about description", done: (c) => !!c?.about?.trim() },
  { label: "at least one photo", done: (c) => !!c?.photoPaths?.length },
  { label: "a location", done: (c, subtype) => (subtype === "venue" ? !!c?.location?.address : !!c?.location?.city) },
  { label: "what you're looking for", done: (c) =>
      validateLookingFor(c?.lookingFor ?? { genres: [], actSizes: [], notes: null }).ok },
];

export default function CuratorDashboard() {
  const { user } = useAuth();
  const router = useRouter();
  const { activeContext, switchTo } = useProfileContext();
  const profileId = typeof activeContext === "object" && activeContext.type === "curator"
    ? activeContext.profileId : null;
  const [profile, setProfile] = useState<ProfileDoc | null>(null);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Identity check for the effect below, closing the same sub-frame race
  // (musician)/portfolio.tsx's activeIdRef closes: React runs effect cleanup
  // AFTER commit+paint, not synchronously during the render-time reset, so a
  // still-in-flight onSnapshot callback for the PREVIOUS profileId could
  // otherwise resolve after the reset below but before its own cleanup has
  // unsubscribed it.
  const activeIdRef = useRef(profileId);

  // Render-time reset, mirroring PhotoUploader's `baseline` pattern and
  // (musician)/portfolio.tsx's `lastProfileId` sentinel: Expo Router's Tabs
  // navigator keeps this screen mounted across a profile-context switch
  // (ContextSwitcher only reassigns activeContext, it never remounts this
  // screen), so without this, switching from curator profile A to curator
  // profile B leaves A's profile state on screen — and editable, and
  // save-able onto B — until the new onSnapshot's first event for B lands.
  const [lastProfileId, setLastProfileId] = useState(profileId);
  if (profileId !== lastProfileId) {
    setLastProfileId(profileId);
    // eslint-disable-next-line react-hooks/refs
    activeIdRef.current = profileId;
    setProfile(null);
  }

  useEffect(() => {
    // profile is already null here: the render-time reset above just ran
    // (or this mounted with profileId already null, matching useState's own
    // default).
    if (!profileId) return;
    const forId = profileId;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", profileId),
      (s) => {
        if (activeIdRef.current !== forId) return;
        setProfile(s.exists() ? (s.data() as ProfileDoc) : null);
      },
      () => {
        if (activeIdRef.current !== forId) return;
        setProfile(null);
      });
  }, [profileId]);

  if (!user || !profileId || !profile) {
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text>{!user || !profileId ? "Switch to a curator profile to edit it." : "Loading…"}</Text></View>;
  }

  const subtype = profile.subtype as CuratorSubtype;
  const c = profile.curator;
  const missing = REQUIREMENTS.filter((r) => !r.done(c, subtype)).map((r) => r.label);
  const canSubmit = missing.length === 0;
  const showSubmit = profile.status === "draft" || profile.status === "rejected";

  const submit = async () => {
    setSubmitBusy(true);
    setSubmitError(null);
    try {
      await httpsCallable(getFirebase().functions, "submitProfileForReview")({ profileId });
    } catch (e) {
      // The 24h resubmit cooldown (failed-precondition) and the
      // 1-pending-curator-profile cap (resource-exhausted) both land here
      // verbatim — this is the "friendly wrapper" the brief calls for. Also
      // the backstop for the ordinary submit-gate race the client-side
      // `missing` check above hasn't caught up to yet.
      setSubmitError(e instanceof Error ? e.message : "Could not submit.");
    } finally {
      setSubmitBusy(false);
    }
  };

  const doDelete = async () => {
    setDeleteBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "deleteProfile")({ profileId });
      // Nothing here nulls activeContext itself — fall back to "fan" (same
      // switch ContextSwitcher's own "Me (fan)" row performs) so this screen
      // doesn't keep pointing at a profile that no longer exists.
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
      `This permanently deletes the profile and its photos, and releases the handle @${profile.handle}. This can't be undone.`,
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
        <View style={{ gap: 4 }}>
          {PUBLIC_PROFILE_HOST_READY && (
            <Pressable onPress={() => void Linking.openURL(`${PUBLIC_PROFILE_HOST}/@${profile.handle}`)}>
              <Text style={{ textDecorationLine: "underline" }}>View public page</Text>
            </Pressable>
          )}
          <Pressable onPress={() => router.push("/(curator)/events")}>
            <Text style={{ textDecorationLine: "underline" }}>Gigs & series →</Text>
          </Pressable>
        </View>
      )}
      {profile.status === "rejected" && (
        <View style={{ backgroundColor: "#fee2e2", borderRadius: 8, padding: 12, gap: 8 }}>
          <Text>
            <Text style={{ fontWeight: "700" }}>Changes requested: </Text>
            {profile.rejectionReason ?? "(no reason provided)"}
          </Text>
        </View>
      )}
      {/* Every section below stays mounted and editable regardless of status
          — there's no separate "wizard" vs "editor" split; the sections ARE
          the wizard, and keep working post-approval as the edit-in-place
          editor, live via the onSnapshot subscription above. Keyed by
          profileId (PREFIXED per section, not bare — React checks key
          uniqueness across ALL of a parent's children, matching web's
          identical fix note on its curator editor page): navigating from one
          curator profile's dashboard to another's must remount these forms
          rather than reuse stale state, since each seeds local state from
          `initial` only once, on mount. */}
      <AboutForm key={`about-${profileId}`} profileId={profileId} initial={c?.about} />
      <GalleryPhotosSection profileId={profileId} uid={user.uid} photoPaths={c?.photoPaths ?? []} />
      <LocationForm key={`location-${profileId}`} profileId={profileId} subtype={subtype} initial={c?.location} />
      <LookingForForm key={`looking-for-${profileId}`} profileId={profileId} initial={c?.lookingFor} />
      <AmenitiesForm key={`amenities-${profileId}`} profileId={profileId} initial={c?.amenities} initialAdvertising={c?.advertisingInterest} />
      {showSubmit && (
        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: "#eee", paddingTop: 16 }}>
          <Text style={{ fontSize: 18, fontWeight: "700" }}>Ready to submit?</Text>
          {REQUIREMENTS.map((r) => {
            const done = r.done(c, subtype);
            return (
              <Text key={r.label} style={{ color: done ? "#16a34a" : "#92400e" }}>
                {done ? "✓" : "○"} {r.label}
              </Text>
            );
          })}
          <Pressable onPress={() => void submit()} disabled={!canSubmit || submitBusy}
            style={{ backgroundColor: "#111", padding: 14, borderRadius: 8, opacity: !canSubmit || submitBusy ? 0.5 : 1 }}>
            <Text style={{ color: "#fff", textAlign: "center" }}>
              {submitBusy ? "Submitting…" : profile.status === "rejected" ? "Resubmit for review" : "Submit for review"}
            </Text>
          </Pressable>
          {!canSubmit && (
            // Plain join, not Intl.ListFormat: unverified under Hermes's ICU
            // data build — see the SP2 plan's DO-NOT-COPY note (web's page
            // uses Intl.ListFormat; this is the deliberately simpler mobile
            // copy, same as (musician)/portfolio.tsx's missingForSubmit hint).
            <Text style={{ color: "#92400e" }}>Add {missing.join(", ")} before submitting.</Text>
          )}
          {submitError && (
            <Text style={{ backgroundColor: "#fef3c7", borderWidth: 1, borderColor: "#fde68a",
              borderRadius: 8, padding: 12, color: "#92400e" }}>
              {submitError}
            </Text>
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
