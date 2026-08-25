"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import { getFirebase } from "../../../src/lib/firebase";
import type { ProfileDoc } from "@gatekeep/shared";

export default function PublicProfile() {
  const { handle } = useParams<{ handle: string }>();
  const [profile, setProfile] = useState<ProfileDoc | null | "loading">("loading");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { db } = getFirebase();
      const h = await getDoc(doc(db, "handles", handle));
      if (cancelled) return;
      if (!h.exists()) { setProfile(null); return; }
      try {
        const p = await getDoc(doc(db, "profiles", h.data().profileId));
        if (cancelled) return;
        setProfile(p.exists() ? (p.data() as ProfileDoc) : null);
      } catch { if (!cancelled) setProfile(null); } // permission-denied = not approved = treat as not found
    })();
    return () => { cancelled = true; };
  }, [handle]);
  if (profile === "loading") return <main><p>Loading…</p></main>;
  if (!profile) return <main><h1>Not found</h1><p>No profile at @{handle}.</p></main>;
  return (
    <main style={{ maxWidth: 640, margin: "40px auto" }}>
      <h1>{profile.name}</h1>
      <p>@{profile.handle} · {profile.type} ({profile.subtype})</p>
      <p><em>Portfolio content arrives in the next phase.</em></p>
    </main>
  );
}
