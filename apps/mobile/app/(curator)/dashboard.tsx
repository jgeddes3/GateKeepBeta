import { useEffect, useRef, useState } from "react";
import { ScrollView, View, Alert, Linking } from "react-native";
import { useRouter } from "expo-router";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebase } from "../../src/lib/firebase";
import { callFn } from "../../src/lib/callable";
import { useAuth } from "../../src/auth/AuthProvider";
import { useProfileContext } from "../../src/shell/ProfileContext";
import { AboutForm, LocationForm, LookingForForm, AmenitiesForm, GalleryPhotosSection } from "../../src/curator/CuratorForms";
import { DelinquencyBanner } from "../../src/payments/DelinquencyBanner";
import { validateLookingFor, type ProfileDoc, type CuratorDetails, type CuratorSubtype, type ProfileStatus } from "@gatekeep/shared";
import { Text, Button, Card, StatusBadge, PageBackground, Skeleton, SkeletonCard, ErrorBanner } from "../../src/ui";
import { useTokens } from "../../src/theme/ThemeProvider";
import { tokens } from "../../src/theme/tokens";

// This tab IS the curator wizard AND the post-approval editor, same shape
// as (musician)/portfolio.tsx and web's dashboard/curator/[profileId]/page.tsx
// "sectioned editor with gate-status" (the accepted Task 9 shape): there's no
// separate multi-step wizard screen. Every section below stays mounted and
// editable at every status; the "Ready to submit?" block only appears while
// draft/rejected.

// Placeholder host until a deployed web domain exists, mirrors
// (musician)/portfolio.tsx's identical constant/gating.
const PUBLIC_PROFILE_HOST = "https://gatekeep.example";
const PUBLIC_PROFILE_HOST_READY = !PUBLIC_PROFILE_HOST.includes("gatekeep.example");

// Presentation-only lookup: maps each ProfileStatus to its StatusBadge tone.
// It does not touch the status-driven behavior below (every `profile.status
// === "..."` comparison is unchanged); it only picks the badge color family.
const STATUS_TONE: Record<ProfileStatus, "success" | "warning" | "destructive" | "neutral"> = {
  draft: "neutral",
  pending_review: "warning",
  approved: "success",
  rejected: "destructive",
};

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
  const t = useTokens();
  const profileId = typeof activeContext === "object" && activeContext.type === "curator"
    ? activeContext.profileId : null;
  const [profile, setProfile] = useState<ProfileDoc | null>(null);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
  // profile B leaves A's profile state on screen (and editable, and
  // save-able onto B) until the new onSnapshot's first event for B lands.
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

  // Empty state: no signed-in user or no active curator profile to edit.
  if (!user || !profileId) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.sm }}>
          <Text variant="title">No curator profile</Text>
          <Text muted style={{ textAlign: "center" }}>Switch to a curator profile to edit it.</Text>
        </View>
      </View>
    );
  }

  // Loading state: profile doc not yet resolved for the active profileId.
  if (!profile) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ padding: tokens.space.lg, gap: tokens.space.lg }}>
          <Skeleton height={28} width="60%" />
          <Skeleton height={16} width="40%" />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      </View>
    );
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
      await callFn("submitProfileForReview", { profileId });
    } catch (e) {
      // The 24h resubmit cooldown (failed-precondition) and the
      // 1-pending-curator-profile cap (resource-exhausted) both land here
      // verbatim. This is the "friendly wrapper" the brief calls for. Also
      // the backstop for the ordinary submit-gate race the client-side
      // `missing` check above hasn't caught up to yet.
      setSubmitError(e instanceof Error ? e.message : "Could not submit.");
    } finally {
      setSubmitBusy(false);
    }
  };

  const doDelete = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await callFn("deleteProfile", { profileId });
      // Nothing here nulls activeContext itself, fall back to "fan" (same
      // switch ContextSwitcher's own "Me (fan)" row performs) so this screen
      // doesn't keep pointing at a profile that no longer exists.
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
      `This permanently deletes the profile and its photos, and releases the handle @${profile.handle}. This can't be undone.`,
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
          <Text variant="label" muted>Status</Text>
          <StatusBadge status={STATUS_TONE[profile.status]} label={profile.status.replace("_", " ")} />
        </View>
        <DelinquencyBanner key={`delinquency-${profileId}`} profileId={profileId} />
        {profile.status === "approved" && (
          <View style={{ gap: tokens.space.sm }}>
            {PUBLIC_PROFILE_HOST_READY && (
              <Button title="View public page" variant="secondary"
                onPress={() => void Linking.openURL(`${PUBLIC_PROFILE_HOST}/@${profile.handle}`)} />
            )}
            <Button title="Gigs & series →" variant="secondary"
              onPress={() => router.push("/(curator)/events")} />
          </View>
        )}
        {profile.status === "rejected" && (
          <Card style={{ gap: tokens.space.sm }}>
            <StatusBadge status="destructive" label="Changes requested" />
            <Text>{profile.rejectionReason ?? "(no reason provided)"}</Text>
          </Card>
        )}
        {/* Every section below stays mounted and editable regardless of
            status. There's no separate "wizard" vs "editor" split; the sections ARE
            the wizard, and keep working post-approval as the edit-in-place
            editor, live via the onSnapshot subscription above. Keyed by
            profileId (PREFIXED per section, not bare, since React checks key
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
          <View style={{ gap: tokens.space.sm, borderTopWidth: 1, borderTopColor: t.border, paddingTop: tokens.space.lg }}>
            <Text variant="title">Ready to submit?</Text>
            {REQUIREMENTS.map((r) => {
              const done = r.done(c, subtype);
              return (
                <Text key={r.label} color={done ? t.success : t.warning}>
                  {done ? "✓" : "○"} {r.label}
                </Text>
              );
            })}
            <Button
              onPress={() => void submit()}
              disabled={!canSubmit || submitBusy}
              title={submitBusy ? "Submitting…" : profile.status === "rejected" ? "Resubmit for review" : "Submit for review"}
            />
            {!canSubmit && (
              // Plain join, not Intl.ListFormat: unverified under Hermes's ICU
              // data build: see the SP2 plan's DO-NOT-COPY note (web's page
              // uses Intl.ListFormat; this is the deliberately simpler mobile
              // copy, same as (musician)/portfolio.tsx's missingForSubmit hint).
              <Text color={t.warning}>Add {missing.join(", ")} before submitting.</Text>
            )}
            <ErrorBanner message={submitError} />
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
