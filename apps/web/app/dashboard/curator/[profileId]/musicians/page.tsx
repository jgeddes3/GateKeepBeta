"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebase } from "../../../../../src/lib/firebase";
import { useAuth } from "../../../../../src/auth/AuthProvider";
import { CuratorFace } from "../../../../../src/search/CuratorFace";
import type { ProfileDoc } from "@gatekeep/shared";
import { Button } from "../../../../../src/ui/button";
import { Skeleton } from "../../../../../src/ui/skeleton";

// Curator-context "Find musicians": member-gated client-side exactly like
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

  if (loading || !user || profile === "loading") {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6 sm:py-14" role="status" aria-label="Loading">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-4 h-9 w-56" />
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-56 w-full" />)}
        </div>
      </main>
    );
  }
  if (!profile || profile.type !== "curator") {
    return (
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16 text-center sm:px-6">
        <p className="font-syne text-lg font-semibold text-gk-text">No curator profile here</p>
        <Button asChild className="mt-4">
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      </main>
    );
  }
  if (profile.status !== "approved") {
    return (
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16 text-center sm:px-6">
        <p className="font-sora text-sm text-gk-muted">
          Your curator profile must be approved before you can find musicians to book.
        </p>
        <Button asChild variant="link" className="mt-2 h-auto p-0">
          <Link href={`/dashboard/curator/${profileId}`}>&larr; Back to profile</Link>
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <Link href={`/dashboard/curator/${profileId}`} className="font-sora text-sm text-gk-muted hover:text-gk-text">
        &larr; {profile.name}
      </Link>
      <h1 className="mt-4 font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Find musicians</h1>
      <div className="mt-8">
        <CuratorFace key={profileId} curatorProfileId={profileId} />
      </div>
    </main>
  );
}
