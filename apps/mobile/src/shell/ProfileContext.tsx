import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { collectionGroup, query, where, onSnapshot, doc, getDoc } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { useAuth } from "../auth/AuthProvider";
import { registerForPush } from "../notifications/push";
import type { ProfileType, ProfileStatus } from "@gatekeep/shared";

export type ProfileSummary = { profileId: string; type: ProfileType; name: string; status: ProfileStatus };
export type ActiveContext = "fan" | ProfileSummary;

type Ctx = { activeContext: ActiveContext; myProfiles: ProfileSummary[]; switchTo: (c: ActiveContext) => void };
const ProfileCtx = createContext<Ctx>({ activeContext: "fan", myProfiles: [], switchTo: () => {} });

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [myProfiles, setMyProfiles] = useState<ProfileSummary[]>([]);
  const [activeContext, setActiveContext] = useState<ActiveContext>("fan");

  useEffect(() => {
    if (!user) { setMyProfiles([]); setActiveContext("fan"); return; }
    let cancelled = false;
    const { db } = getFirebase();
    const unsubscribe = onSnapshot(query(collectionGroup(db, "members"), where("uid", "==", user.uid)), async (snap) => {
      const results: ProfileSummary[] = [];
      for (const m of snap.docs) {
        if (cancelled) return;
        const profileRef = m.ref.parent.parent!;
        const p = await getDoc(doc(db, "profiles", profileRef.id));
        if (cancelled) return;
        if (p.exists()) {
          const d = p.data();
          results.push({ profileId: p.id, type: d.type, name: d.name, status: d.status });
        }
      }
      if (!cancelled) setMyProfiles(results);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [user?.uid]);

  // Separate, standalone effect: registering the Expo push token is fire-and-forget
  // and doesn't feed any state in this provider, so it must not share the "my
  // profiles" effect above (that one's cancellation guard exists specifically to
  // sequence async setState calls against unmount/uid-change).
  useEffect(() => {
    if (!user) return;
    void registerForPush(user.uid);
  }, [user?.uid]);

  return (
    <ProfileCtx.Provider value={{ activeContext, myProfiles, switchTo: setActiveContext }}>
      {children}
    </ProfileCtx.Provider>
  );
}
export const useProfileContext = () => useContext(ProfileCtx);
