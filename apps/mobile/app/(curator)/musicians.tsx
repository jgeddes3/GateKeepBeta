import { useEffect, useRef, useState } from "react";
import { View, Text } from "react-native";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import { useProfileContext } from "../../src/shell/ProfileContext";
import { MusicianBrowse } from "../../src/bookings/MusicianBrowse";
import type { ProfileDoc } from "@gatekeep/shared";

// Curator "Find musicians" tab (SP4 Task 12) — replaces the earlier
// "Find Talent" placeholder (talent.tsx, deleted). Gated the same way
// (curator)/events/index.tsx gates its own content: an approved curator
// profile is required both to browse usefully (offerGig needs one) and to
// match web's dashboard/curator/[profileId]/musicians/page.tsx gate.
export default function Musicians() {
  const { user } = useAuth();
  const { activeContext } = useProfileContext();
  const profileId = typeof activeContext === "object" && activeContext.type === "curator"
    ? activeContext.profileId : null;
  const [profile, setProfile] = useState<ProfileDoc | null>(null);

  const activeIdRef = useRef(profileId);
  const [lastProfileId, setLastProfileId] = useState(profileId);
  if (profileId !== lastProfileId) {
    setLastProfileId(profileId);
    // eslint-disable-next-line react-hooks/refs
    activeIdRef.current = profileId;
    setProfile(null);
  }

  useEffect(() => {
    if (!profileId) return;
    const forId = profileId;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", profileId),
      (s) => { if (activeIdRef.current !== forId) return; setProfile(s.exists() ? (s.data() as ProfileDoc) : null); },
      () => { if (activeIdRef.current !== forId) return; setProfile(null); });
  }, [profileId]);

  if (!user || !profileId || !profile) {
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text>{!user || !profileId ? "Switch to a curator profile to find musicians." : "Loading…"}</Text></View>;
  }
  if (profile.status !== "approved") {
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <Text style={{ textAlign: "center", color: "#666" }}>
        Your curator profile must be approved before you can find musicians to book.
      </Text></View>;
  }

  return <MusicianBrowse key={profileId} curatorProfileId={profileId} />;
}
