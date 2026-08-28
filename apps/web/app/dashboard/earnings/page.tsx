"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { collectionGroup, query, where, onSnapshot, doc, getDoc } from "firebase/firestore";
import { getFirebase } from "../../../src/lib/firebase";
import { useAuth } from "../../../src/auth/AuthProvider";
import { EarningsPanel } from "../../../src/payments/EarningsPanel";
import type { ProfileDoc } from "@gatekeep/shared";

type MusicianProfileSummary = { profileId: string; name: string };

// Same "my profiles" subscription idiom as app/dashboard/page.tsx's
// ProfilesList (collectionGroup('members').where('uid','==',uid), then a
// per-doc profile get()), filtered to type === "musician" — payouts are the
// musician half of a profile (Stripe Connect Express), so a curator-only
// profile has nothing to show on this page. Mounted with key={user.uid} by
// the page below for the same remount-on-identity-change reason ProfilesList
// documents.
function MusicianProfilesList({ uid }: { uid: string }) {
  const [profiles, setProfiles] = useState<MusicianProfileSummary[] | "loading">("loading");
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const unsubscribe = onSnapshot(query(collectionGroup(db, "members"), where("uid", "==", uid)), async (snap) => {
      const out: MusicianProfileSummary[] = [];
      for (const m of snap.docs) {
        if (cancelled) return;
        const p = await getDoc(doc(db, "profiles", m.ref.parent.parent!.id));
        if (cancelled) return;
        if (p.exists()) {
          const d = p.data() as ProfileDoc;
          if (d.type === "musician") out.push({ profileId: p.id, name: d.name });
        }
      }
      if (!cancelled) setProfiles(out);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [uid]);

  if (profiles === "loading") return <p>Loading…</p>;
  if (profiles.length === 0) {
    return <p>No musician profiles yet — <a href="/join">create one</a> to start getting booked and paid.</p>;
  }
  return <>{profiles.map((p) => <EarningsPanel key={p.profileId} profileId={p.profileId} name={p.name} />)}</>;
}

export default function EarningsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  if (loading || !user) return null;
  return (
    <main style={{ maxWidth: 760, margin: "40px auto", display: "grid", gap: 24 }}>
      <h1>Earnings &amp; payouts</h1>
      <p><a href="/dashboard">Back to dashboard</a></p>
      <MusicianProfilesList key={`earnings-${user.uid}`} uid={user.uid} />
    </main>
  );
}
