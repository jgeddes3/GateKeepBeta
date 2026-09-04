"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { collectionGroup, query, where, onSnapshot, doc, getDoc } from "firebase/firestore";
import { getFirebase } from "../../../src/lib/firebase";
import { useAuth } from "../../../src/auth/AuthProvider";
import { EarningsPanel } from "../../../src/payments/EarningsPanel";
import type { ProfileDoc } from "@gatekeep/shared";
import { Skeleton } from "../../../src/ui/skeleton";
import { IconEarnings } from "../../../src/ui/icons";

type ProfileSummary = { profileId: string; name: string; type: ProfileDoc["type"] };

// Same "my profiles" subscription idiom as app/dashboard/page.tsx's
// ProfilesList (collectionGroup('members').where('uid','==',uid), then a
// per-doc profile get()). SP5c Task 9: curator profiles now get an Earnings
// panel too (ticket settlements, shares of their own ticket revenue), so
// this lists both musician and curator profiles, not musician-only.
// Mounted with key={user.uid} by the page below for the same
// remount-on-identity-change reason ProfilesList documents.
function EarningsProfilesList({ uid }: { uid: string }) {
  const [profiles, setProfiles] = useState<ProfileSummary[] | "loading">("loading");
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
          if (d.type === "musician" || d.type === "curator") out.push({ profileId: p.id, name: d.name, type: d.type });
        }
      }
      if (!cancelled) setProfiles(out);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [uid]);

  if (profiles === "loading") {
    return (
      <div className="grid gap-2" role="status" aria-label="Loading your profiles">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-40" />
      </div>
    );
  }
  if (profiles.length === 0) {
    return (
      <p className="flex items-start gap-2 font-sora text-sm text-gk-muted">
        <IconEarnings size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        No profiles yet.{" "}
        <a href="/join" className="text-gk-text underline underline-offset-4 hover:text-gk-focus">Create one</a>
        {" "}to start getting booked and paid.
      </p>
    );
  }
  return <>{profiles.map((p) => <EarningsPanel key={p.profileId} profileId={p.profileId} name={p.name} type={p.type} />)}</>;
}

function EarningsPageSkeleton() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14" role="status" aria-label="Loading">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-9 w-2/3" />
    </main>
  );
}

export default function EarningsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  if (loading || !user) return <EarningsPageSkeleton />;
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <a href="/dashboard" className="font-sora text-sm text-gk-muted hover:text-gk-text">&larr; Back to dashboard</a>
      <h1 className="mt-4 font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Earnings &amp; payouts</h1>
      <div className="mt-8">
        <EarningsProfilesList key={`earnings-${user.uid}`} uid={user.uid} />
      </div>
    </main>
  );
}
