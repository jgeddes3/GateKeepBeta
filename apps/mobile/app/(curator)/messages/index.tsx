import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { doc, onSnapshot } from "firebase/firestore";
import { useRouter } from "expo-router";
import { getFirebase } from "../../../src/lib/firebase";
import { useAuth } from "../../../src/auth/AuthProvider";
import { useProfileContext } from "../../../src/shell/ProfileContext";
import { ConversationList } from "../../../src/messaging/ConversationList";
import type { ProfileDoc } from "@gatekeep/shared";
import { Text, Button, Card, ErrorBanner, PageBackground, Skeleton, SkeletonCard } from "../../../src/ui";
import { tokens } from "../../../src/theme/tokens";

// SP12 Task 10: was the "Direct messages, coming soon." placeholder,
// replaced by the real inbox for the active curator profile. Gated the same
// way (curator)/bookings.tsx gates BookingInbox: this profile must be an
// APPROVED curator profile (checked with .type, not just "not fan":
// activeContext is a single global value shared across both tab groups, so
// it can hold a musician profile while this curator-tab screen is mounted,
// e.g. after a direct navigation).
export default function CuratorMessages() {
  const { user } = useAuth();
  const { activeContext } = useProfileContext();
  const router = useRouter();
  const profileId = typeof activeContext === "object" && activeContext.type === "curator"
    ? activeContext.profileId : null;

  // Four-way sentinel (audit #11), see (curator)/dashboard.tsx's identical
  // comment: a failed read is distinct from a not-yet-loaded or a
  // genuinely-missing profile.
  const [profile, setProfile] = useState<ProfileDoc | null | "loading" | "error">("loading");
  const [profileRetry, setProfileRetry] = useState(0);
  // Same render-time-reset + late-callback guard as the sibling
  // bookings/dashboard/events screens: this tab stays mounted across a
  // profile-context switch, so without both a stale previous profile's
  // approval state could flash before the new one resolves.
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
        console.error("CuratorMessages: profile onSnapshot failed", e);
        setProfile("error");
      });
  }, [profileId, profileRetry]);

  if (!user || !profileId || profile === "loading") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        {!user || !profileId ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl }}>
            <Card style={{ gap: tokens.space.sm }}>
              <Text muted style={{ textAlign: "center" }}>Switch to a curator profile to see its messages.</Text>
            </Card>
          </View>
        ) : (
          <View style={{ padding: tokens.space.lg, gap: tokens.space.lg }}>
            <Skeleton height={24} width="55%" />
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
          <ErrorBanner message="Couldn't load this." />
          <Button title="Retry" variant="secondary" style={{ alignSelf: "flex-start" }}
            onPress={() => { setProfile("loading"); setProfileRetry((n) => n + 1); }} />
        </View>
      </View>
    );
  }
  if (!profile || profile.status !== "approved") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl }}>
          <Card style={{ gap: tokens.space.sm }}>
            <Text muted style={{ textAlign: "center" }}>Switch to a curator profile to see its messages.</Text>
          </Card>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ConversationList
        key={profileId}
        profileId={profileId}
        onOpen={(conversationId) => router.push({ pathname: "/(curator)/messages/[conversationId]", params: { conversationId } })}
      />
    </View>
  );
}
