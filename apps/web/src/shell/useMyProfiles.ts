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
// Shared implementation behind both hooks below: useMyProfiles keeps the
// bare-array return every existing caller (OfferGigButton, AppShell) already
// depends on, and useMyProfilesState adds `loaded` for SearchFaces, which
// needs to know "the first snapshot hasn't arrived yet" (or "signed out, so
// there never will be one") to hold its own face choice rather than
// defaulting to FanFace for a moment on every signed-in visit.
function useMyProfilesInternal(uid: string | null): { profiles: ProfileSummary[]; loaded: boolean } {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [loaded, setLoaded] = useState(uid === null);
  const [trackedUid, setTrackedUid] = useState(uid);
  if (uid !== trackedUid) {
    setTrackedUid(uid);
    setProfiles([]);
    setLoaded(uid === null);
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
      if (!cancelled) { setProfiles(out); setLoaded(true); }
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [uid]);
  return { profiles, loaded };
}

export function useMyProfiles(uid: string | null): ProfileSummary[] {
  return useMyProfilesInternal(uid).profiles;
}

// SearchFaces' own hook (fix round 1 minor #5): the array-only shape above
// has no way to say "still loading" versus "loaded and empty", and every
// other caller of useMyProfiles already depends on the bare-array return, so
// this is a second hook onto the same subscription rather than a breaking
// change to that shape.
export function useMyProfilesState(uid: string | null): { profiles: ProfileSummary[]; loaded: boolean } {
  return useMyProfilesInternal(uid);
}

// Same destination as ProfilesList's editHref: the switcher and nav send
// someone to the exact same place clicking their name in "Your profiles"
// already would, just from the shell instead of the page body.
export function profileHref(p: ProfileSummary): string {
  return p.type === "musician" ? `/dashboard/portfolio/${p.profileId}` : `/dashboard/curator/${p.profileId}`;
}

// NOT the same display as ProfilesList's editLabel, deliberately.
// editLabel returns an action phrase ("finish setup", "revise and
// resubmit", "edit portfolio") meant to stand alone as a page-level link's
// full text. This is a status-noun suffix ("draft", "pending review") shown
// after the profile's own name and type inside a compact multi-row switcher
// item, matching the format apps/mobile/src/shell/ContextSwitcher.tsx
// already uses for the same "profile name (type), status" switcher-row
// shape, rather than the page's action-link convention. The destination
// (profileHref above) is what the brief asked to keep identical; this label
// is new display text for a UI surface (a global switcher) that didn't
// exist on web before this task.
export function profileStatusLabel(p: ProfileSummary): string | null {
  return p.status === "approved" ? null : p.status.replace("_", " ");
}
