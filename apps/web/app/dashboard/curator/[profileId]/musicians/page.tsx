"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebase } from "../../../../../src/lib/firebase";
import { useAuth } from "../../../../../src/auth/AuthProvider";
import { MusicianBrowse } from "../../../../../src/bookings/MusicianBrowse";
import type { ProfileDoc } from "@gatekeep/shared";

// Curator-context "Find musicians" — member-gated client-side exactly like
// the other curator dashboard pages (see gigs/page.tsx and gigs/new/page.tsx
// for the identical auth/membership guard shape this mirrors).
export default function FindMusicians(props: { params: Promise<{ profileId: string }> }) {
  const { profileId } = use(props.params);
  const { user, loading } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileDoc | null | "loading">("loading");

  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", profileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null),
      () => setProfile(null));
  }, [user, profileId]);

  if (loading || !user || profile === "loading") return <main><p>Loading…</p></main>;
  if (!profile || profile.type !== "curator") return <main><p>No curator profile here.</p></main>;
  if (profile.status !== "approved") {
    return (
      <main style={{ maxWidth: 640, margin: "40px auto" }}>
        <p>Your curator profile must be approved before you can find musicians to book.</p>
        <a href={`/dashboard/curator/${profileId}`}>← Back to profile</a>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 840, margin: "40px auto", display: "grid", gap: 24 }}>
      <a href={`/dashboard/curator/${profileId}`} style={{ color: "#666", fontSize: 14 }}>← {profile.name}</a>
      <h1>Find musicians</h1>
      <MusicianBrowse key={profileId} curatorProfileId={profileId} />
    </main>
  );
}
