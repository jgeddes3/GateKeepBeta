"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { collectionGroup, collection, query, where, orderBy, limit, onSnapshot, doc, getDoc, updateDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import type { ProfileType, ProfileStatus, ProfileDoc, NotificationDoc } from "@gatekeep/shared";

type ProfileSummary = { profileId: string; type: ProfileType; name: string; status: ProfileStatus };
type NotificationRow = { id: string } & NotificationDoc;

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
  const editHref = (p: ProfileSummary) =>
    p.type === "musician" ? `/dashboard/portfolio/${p.profileId}` : `/dashboard/curator/${p.profileId}`;
  const editLabel = (p: ProfileSummary) =>
    p.status === "draft" ? "finish setup"
      : p.status === "rejected" ? "revise & resubmit"
      : p.type === "musician" ? "edit portfolio" : "edit profile";
  return (
    <>
      {profiles.length === 0 && <p>None yet — <a href="/join">create a profile</a> (musician or curator), or from the mobile app.</p>}
      <ul>{profiles.map((p) => (
        <li key={p.profileId}>
          {p.name} — {p.type} — {p.status.replace("_", " ")}
          {" · "}<a href={editHref(p)}>{editLabel(p)}</a>
        </li>
      ))}</ul>
    </>
  );
}

// Same rationale as ProfilesList above: owns the notifications subscription for exactly
// one signed-in uid, remounted via key={user.uid} by Dashboard so `notes` resets on
// identity change instead of a setState-in-effect reset. Web has no background push
// (deliberately deferred — see task 13 notes); this realtime inbox is the only surface.
function NotificationsList({ uid }: { uid: string }) {
  const [notes, setNotes] = useState<NotificationRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const unsubscribe = onSnapshot(
      query(collection(db, `users/${uid}/notifications`), orderBy("createdAt", "desc"), limit(30)),
      (snap) => {
        if (cancelled) return;
        setNotes(snap.docs.map((d) => ({ id: d.id, ...(d.data() as NotificationDoc) })));
      });
    return () => { cancelled = true; unsubscribe(); };
  }, [uid]);
  const markRead = (id: string) =>
    updateDoc(doc(getFirebase().db, `users/${uid}/notifications/${id}`), { read: true });
  return (
    <>
      {notes.length === 0 && <p>No notifications yet.</p>}
      <ul>{notes.map((n) => {
        // SP4 Task 10: a "booking" notification carries refId (the
        // bookingId — see Task 10a's NotificationDoc.refId plumbing) once
        // it was written after that field existed; a booking-kind row
        // written before then (or, defensively, any other kind) has no
        // refId and renders as plain text, same as before.
        const href = n.kind === "booking" && n.refId ? `/dashboard/bookings/${n.refId}` : null;
        const body = (
          <>
            <strong>{n.title}</strong>
            <p style={{ margin: 0 }}>{n.body}</p>
          </>
        );
        return (
          <li key={n.id} style={{ opacity: n.read ? 0.5 : 1 }}>
            {href ? (
              // Next <Link> (client-side nav), not a plain <a> — a full-
              // document navigation can abort the in-flight markRead()
              // updateDoc before it lands (Task 10 review); client-side
              // routing lets the write complete regardless of the nav.
              <Link href={href} onClick={() => markRead(n.id)} style={{ color: "inherit", textDecoration: "none", cursor: "pointer" }}>
                {body}
              </Link>
            ) : (
              <span onClick={() => markRead(n.id)} style={{ cursor: "pointer" }}>{body}</span>
            )}
          </li>
        );
      })}</ul>
    </>
  );
}

export default function Dashboard() {
  const { user, loading, signOutUser } = useAuth();
  const router = useRouter();
  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  if (loading || !user) return null;
  const deleteAccount = async () => {
    if (!window.confirm("This permanently deletes your account and data. Continue?")) return;
    try {
      await httpsCallable(getFirebase().functions, "deleteAccount")({});
      // Navigate away first: this unmounts Dashboard (and its auth-guard
      // effect above), so that effect can't race signOutUser() below and
      // redirect to /sign-in first — landing the user somewhere other than
      // "/". The callable already deleted the auth user server-side; sign
      // out locally afterward so client state doesn't depend on
      // onAuthStateChanged noticing the now-invalid token on its own.
      router.push("/");
      await signOutUser();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Can't delete yet.");
    }
  };
  return (
    <main style={{ maxWidth: 760, margin: "40px auto" }}>
      <h1>Dashboard</h1>
      <p>
        {user.email} · <button onClick={signOutUser}>Sign out</button>
        {" · "}
        <button onClick={deleteAccount} style={{ color: "#dc2626" }}>Delete account</button>
      </p>
      <h2>Your profiles</h2>
      {/* Pre-existing bug fixed in passing (found live during this task's
          browser walkthrough, not introduced by it — see git blame): both
          keys were bare `user.uid`, and React key uniqueness is checked
          across ALL of a parent's children, not just same-type siblings —
          two elements sharing a key is exactly the "two children with the
          same key" console error this threw. Prefixing per component keeps
          each unique while still forcing the same identity-switch remount
          on sign-out/sign-in this key was already here for. */}
      <ProfilesList key={`profiles-${user.uid}`} uid={user.uid} />
      <h2>Notifications</h2>
      <NotificationsList key={`notifications-${user.uid}`} uid={user.uid} />
    </main>
  );
}
