"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { collectionGroup, query, where, onSnapshot, doc, getDoc } from "firebase/firestore";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import type { ProfileType, ProfileStatus, ProfileDoc } from "@gatekeep/shared";

type ProfileSummary = { profileId: string; type: ProfileType; name: string; status: ProfileStatus };

export default function Dashboard() {
  const { user, loading, signOutUser } = useAuth();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const router = useRouter();
  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(query(collectionGroup(db, "members"), where("uid", "==", user.uid)), async (snap) => {
      const out: ProfileSummary[] = [];
      for (const m of snap.docs) {
        const p = await getDoc(doc(db, "profiles", m.ref.parent.parent!.id));
        if (p.exists()) {
          const d = p.data() as ProfileDoc;
          out.push({ profileId: p.id, type: d.type, name: d.name, status: d.status });
        }
      }
      setProfiles(out);
    });
  }, [user?.uid]);
  if (loading || !user) return null;
  return (
    <main style={{ maxWidth: 760, margin: "40px auto" }}>
      <h1>Dashboard</h1>
      <p>{user.email} · <button onClick={signOutUser}>Sign out</button></p>
      <h2>Your profiles</h2>
      {profiles.length === 0 && <p>None yet — join as a musician or curator from the mobile app, or right here once wizards land in the next phase.</p>}
      <ul>{profiles.map((p) => (
        <li key={p.profileId}>{p.name} — {p.type} — {p.status.replace("_", " ")}</li>
      ))}</ul>
    </main>
  );
}
