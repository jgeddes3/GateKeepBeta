import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import { useProfileContext } from "../../src/shell/ProfileContext";
import { CuratorFace } from "../../src/search/CuratorFace";
import { useSavedSearchRestore } from "../../src/search/useSavedSearchRestore";
import type { ProfileDoc } from "@gatekeep/shared";
import { Text, Button, ErrorBanner, PageBackground, Skeleton, SkeletonCard } from "../../src/ui";
import { tokens } from "../../src/theme/tokens";

// Curator "Find musicians" tab (SP8 Task 15/17): the curator search face,
// replacing the earlier browse placeholder. Gated the same way
// (curator)/events/index.tsx gates its own content: an approved curator
// profile is required both to browse usefully (offerGig needs one) and to
// match web's dashboard/curator/[profileId]/musicians/page.tsx gate. `saved`
// resolves through useSavedSearchRestore before CuratorFace ever mounts (its
// `initial` prop only takes effect at mount); a missing or
// permission-denied doc just renders the empty face, no alert.
export default function Musicians() {
  const { user } = useAuth();
  const { activeContext } = useProfileContext();
  const { saved } = useLocalSearchParams<{ saved?: string }>();
  const { ready: savedReady, initial } = useSavedSearchRestore(saved);
  const profileId = typeof activeContext === "object" && activeContext.type === "curator"
    ? activeContext.profileId : null;
  // Four-way sentinel (audit #11), see (curator)/dashboard.tsx's identical
  // comment.
  const [profile, setProfile] = useState<ProfileDoc | "loading" | "error" | null>("loading");
  const [profileRetry, setProfileRetry] = useState(0);

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
        console.error("Musicians: profile onSnapshot failed", e);
        setProfile("error");
      });
  }, [profileId, profileRetry]);

  if (!user || !profileId || profile === "loading" || !savedReady) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        {!user || !profileId ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.sm }}>
            <Text variant="title">No curator profile</Text>
            <Text muted style={{ textAlign: "center" }}>Switch to a curator profile to find musicians.</Text>
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
  if (profile.status !== "approved") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.sm }}>
          <Text variant="title">Not approved yet</Text>
          <Text muted style={{ textAlign: "center" }}>Your curator profile must be approved before you can find musicians to book.</Text>
        </View>
      </View>
    );
  }

  return <CuratorFace key={profileId} curatorProfileId={profileId} initial={initial} />;
}
