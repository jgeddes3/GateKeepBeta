"use client";
import { useEffect, useState } from "react";
import { collectionGroup, doc, getDoc, onSnapshot, query, where } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import type { ProfileType, ProfileStatus, ProfileDoc } from "@gatekeep/shared";

export type ProfileSummary = { profileId: string; type: ProfileType; name: string; status: ProfileStatus };

// Same "my profiles" subscription shape as app/dashboard/page.tsx's ProfilesList
// (collectionGroup('members').where('uid','==',uid), then a per-doc profile
// getDoc): the shell's nav and account/context switcher both need this list to
// decide what to show and where to send someone, so it lives here once instead
// of two separate onSnapshot listeners doing the identical query. Returns []
// (not "loading") while signed out or before the first snapshot arrives, same
// as ProfilesList's own initial state.
//
// ProfilesList resets on an identity change by remounting via key={user.uid}
// (see that component's own comment on why: eslint-config-next's React
// Compiler rules flag a synchronous setState-in-effect reset). This hook has
// no such remount available: the shell renders continuously across
// navigation, so it uses the render-time reset pattern instead (same one
// PortfolioEditor's `bookingProfileId` uses): adjusting state synchronously
// during render when `uid` itself changes, which React re-renders once more
// before committing, so the reset is never painted stale.
export function useMyProfiles(uid: string | null): ProfileSummary[] {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [trackedUid, setTrackedUid] = useState(uid);
  if (uid !== trackedUid) {
    setTrackedUid(uid);
    setProfiles([]);
  }
  useEffect(() => {
    if (!uid) return;
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
  return profiles;
}

// Same destination + label mapping as ProfilesList's editHref/editLabel: the
// switcher and nav send someone to the exact same place clicking their name in
// "Your profiles" already would, just from the shell instead of the page body.
export function profileHref(p: ProfileSummary): string {
  return p.type === "musician" ? `/dashboard/portfolio/${p.profileId}` : `/dashboard/curator/${p.profileId}`;
}

export function profileStatusLabel(p: ProfileSummary): string | null {
  return p.status === "approved" ? null : p.status.replace("_", " ");
}
