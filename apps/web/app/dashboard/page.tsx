"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { collectionGroup, query, where, onSnapshot, doc, getDoc } from "firebase/firestore";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import type { ProfileType, ProfileStatus, ProfileDoc } from "@gatekeep/shared";

type ProfileSummary = { profileId: string; type: ProfileType; name: string; status: ProfileStatus };

// Owns the "my profiles" subscription for exactly one signed-in uid. Mounted with
// key={user.uid} by Dashboard below, so React remounts (and thus resets `profiles` to [])
// whenever the signed-in identity changes — signed out, or a different user signs in —
// instead of a synchronous setState-in-effect reset, which eslint-config-next's React
// Compiler rules (react-hooks/set-state-in-effect) flag as an anti-pattern.
function ProfilesList({ uid }: { uid: string }) {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const unsubscribe = onSnapshot(query(collectionGroup(db, "members"), where("uid", "==", uid)), async (snap) => {
      const out: ProfileSummary[] = [];
      for (const m of snap.docs) {
        if (cancelled) return;
        const p = await getDoc(doc(db, "profiles", m.ref.parent.parent!.id));
        if (cancelled) return;
        if (p.exists()) {
          const d = p.data() as ProfileDoc;
          out.push({ profileId: p.id, type: d.type, name: d.name, status: d.status });
        }
      }
      if (!cancelled) setProfiles(out);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [uid]);
  return (
    <>
      {profiles.length === 0 && <p>None yet — join as a musician or curator from the mobile app, or right here once wizards land in the next phase.</p>}
      <ul>{profiles.map((p) => (
        <li key={p.profileId}>{p.name} — {p.type} — {p.status.replace("_", " ")}</li>
      ))}</ul>
    </>
  );
}

export default function Dashboard() {
  const { user, loading, signOutUser } = useAuth();
  const router = useRouter();
  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  if (loading || !user) return null;
  return (
    <main style={{ maxWidth: 760, margin: "40px auto" }}>
      <h1>Dashboard</h1>
      <p>{user.email} · <button onClick={signOutUser}>Sign out</button></p>
      <h2>Your profiles</h2>
      <ProfilesList key={user.uid} uid={user.uid} />
    </main>
  );
}
