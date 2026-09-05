import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import { useProfileContext } from "../../src/shell/ProfileContext";
import { BookingInbox } from "../../src/bookings/BookingInbox";
import type { ProfileDoc } from "@gatekeep/shared";
import { Text, Button, ErrorBanner, PageBackground, Skeleton, SkeletonCard } from "../../src/ui";
import { tokens } from "../../src/theme/tokens";

// Musician "Bookings" tab (SP4 Task 12), gated on the active profile
// context the same way (curator)/events/index.tsx and (musician)/portfolio.tsx
// gate their own content: BookingInbox only makes sense for ONE approved
// musician profile at a time (the active context), mirroring web's
// per-profile inbox section on the portfolio editor page.
export default function Bookings() {
  const { user } = useAuth();
  const { activeContext } = useProfileContext();
  const profileId = typeof activeContext === "object" && activeContext.type === "musician"
    ? activeContext.profileId : null;
  // Four-way sentinel (audit #11), see (curator)/dashboard.tsx's identical
  // comment: a failed read is distinct from a not-yet-loaded or a
  // genuinely-missing profile.
  const [profile, setProfile] = useState<ProfileDoc | "loading" | "error" | null>("loading");
  const [profileRetry, setProfileRetry] = useState(0);

  // Same render-time-reset + late-callback guard as the sibling
  // dashboard/portfolio/events screens: this tab stays mounted across a
  // profile-context switch (Expo Router's Tabs navigator doesn't remount
  // it), so without both, switching musician profiles could leave the
  // PREVIOUS profile's inbox on screen.
  const activeIdRef = useRef(profileId);
  const [lastProfileId, setLastProfileId] = useState(profileId);
  if (profileId !== lastProfileId) {
    setLastProfileId(profileId);
    // eslint-disable-next-line react-hooks/refs
    activeIdRef.current = profileId;
    setProfile("loading");
  }

  useEffect(() => {
    if (!profileId) return;
    const forId = profileId;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", profileId),
      (s) => { if (activeIdRef.current !== forId) return; setProfile(s.exists() ? (s.data() as ProfileDoc) : null); },
      (e) => {
        if (activeIdRef.current !== forId) return;
        console.error("Bookings: profile onSnapshot failed", e);
        setProfile("error");
      });
  }, [profileId, profileRetry]);

  if (!user || !profileId || profile === "loading") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        {!user || !profileId ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.sm }}>
            <Text variant="title">No musician profile</Text>
            <Text muted style={{ textAlign: "center" }}>Switch to a musician profile to see its bookings.</Text>
          </View>
        ) : (
          <View style={{ padding: tokens.space.lg, gap: tokens.space.lg }}>
            <Skeleton height={24} width="55%" />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </View>
        )}
      </View>
    );
  }
  if (profile === "error") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ padding: tokens.space.lg, gap: tokens.space.md }}>
          <ErrorBanner message="Couldn't load this. Retry." />
          <Button title="Retry" variant="secondary" style={{ alignSelf: "flex-start" }}
            onPress={() => { setProfile("loading"); setProfileRetry((n) => n + 1); }} />
        </View>
      </View>
    );
  }
  if (!profile) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.sm }}>
          <Text variant="title">Profile not found</Text>
          <Text muted style={{ textAlign: "center" }}>This profile may have been deleted.</Text>
        </View>
      </View>
    );
  }
  // Only an approved musician profile can have bookings at all
  // (applyToGig/offerGig both require requireApprovedMusicianProfile),
  // mirrors the portfolio tab's identical gate for the inbox section.
  if (profile.status !== "approved") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.sm }}>
          <Text variant="title">Not approved yet</Text>
          <Text muted style={{ textAlign: "center" }}>Your musician profile must be approved before it can have bookings.</Text>
        </View>
      </View>
    );
  }

  return <BookingInbox key={profileId} profileId={profileId} role="musician" />;
}
