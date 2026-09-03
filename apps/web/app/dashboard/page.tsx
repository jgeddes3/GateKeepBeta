"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { collectionGroup, collection, query, where, orderBy, limit, onSnapshot, doc, getDoc, updateDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import { cn } from "../../src/lib/utils";
import type { ProfileType, ProfileStatus, ProfileDoc, NotificationDoc } from "@gatekeep/shared";
import { Button } from "../../src/ui/button";
import { Card, CardContent } from "../../src/ui/card";
import { Badge } from "../../src/ui/badge";
import { Skeleton } from "../../src/ui/skeleton";
import { IconBell, IconBuildings, IconEarnings, IconGigs, IconUser, IconWarning } from "../../src/ui/icons";

// Task 9 (SP7): followerCount, read straight off the same profile doc this
// list already fetches per membership (ProfileDoc.followerCount?: number,
// server-maintained, absent on a profile with zero follows so `?? 0` at the
// render site is the only place that matters). Shown only here, a private
// dashboard row belonging to the profile's own members: firestore.rules
// never exposes it on a public profile read, and this page never renders it
// on /u/[handle] either, so the binding "follower counts stay private" rule
// holds by construction, not by a rendering choice this file could get wrong.
type ProfileSummary = { profileId: string; type: ProfileType; name: string; status: ProfileStatus; followerCount: number };
type NotificationRow = { id: string } & NotificationDoc;

// Real state, not decoration: draft has no strong tint (it isn't a review
// outcome yet), the other three map onto DESIGN.md's success/warning/
// destructive status-tint family.
const STATUS_BADGE: Record<ProfileStatus, { variant: "secondary" | "warning" | "success" | "destructive"; label: string }> = {
  draft: { variant: "secondary", label: "Draft" },
  pending_review: { variant: "warning", label: "Pending review" },
  approved: { variant: "success", label: "Approved" },
  rejected: { variant: "destructive", label: "Rejected" },
};

// Owns the "my profiles" subscription for exactly one signed-in uid. Mounted with
// key={user.uid} by Dashboard below, so React remounts (and thus resets `profiles` to [])
// whenever the signed-in identity changes (signed out, or a different user signs in)
// instead of a synchronous setState-in-effect reset, which eslint-config-next's React
// Compiler rules (react-hooks/set-state-in-effect) flag as an anti-pattern.
function ProfilesList({ uid }: { uid: string }) {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
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
          out.push({ profileId: p.id, type: d.type, name: d.name, status: d.status, followerCount: d.followerCount ?? 0 });
        }
      }
      if (!cancelled) { setProfiles(out); setLoaded(true); }
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [uid]);
  const editHref = (p: ProfileSummary) =>
    p.type === "musician" ? `/dashboard/portfolio/${p.profileId}` : `/dashboard/curator/${p.profileId}`;
  const editLabel = (p: ProfileSummary) =>
    p.status === "draft" ? "finish setup"
      : p.status === "rejected" ? "revise & resubmit"
      : p.type === "musician" ? "edit portfolio" : "edit profile";

  if (!loaded) {
    return (
      <div className="grid gap-3" role="status" aria-label="Loading your profiles">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-4 rounded-gk border border-gk-border bg-gk-surface p-5">
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-8 w-24" />
          </div>
        ))}
      </div>
    );
  }

  if (profiles.length === 0) {
    return (
      <div className="rounded-gk border border-gk-border bg-gk-surface px-6 py-8 text-center">
        <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
          <IconUser size={20} aria-hidden="true" />
        </span>
        <p className="mt-3 font-syne text-base font-semibold text-gk-text">No profiles yet</p>
        <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
          Set up a musician or curator profile and this becomes home base: gigs, bookings, all of it.
          You can also start one from the mobile app.
        </p>
        <Button asChild className="mt-4">
          <Link href="/join">Create a profile</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {profiles.map((p) => {
        const status = STATUS_BADGE[p.status];
        const TypeIcon = p.type === "musician" ? IconGigs : IconBuildings;
        return (
          <Card key={p.profileId}>
            <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
                  <TypeIcon size={20} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="truncate font-syne text-base font-semibold text-gk-text">{p.name}</p>
                  <p className="font-sora text-sm text-gk-muted">
                    {p.type === "musician" ? "Musician" : "Curator"} · {p.followerCount} follower{p.followerCount === 1 ? "" : "s"}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Badge variant={status.variant}>{status.label}</Badge>
                <Button asChild variant="secondary" size="sm">
                  <Link href={editHref(p)}>{editLabel(p)}</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// Task 9 (SP7): resolves one profileId to its handle for the ONE
// notification kind that carries a profileId rather than a ready-made route
// (new_music, refId = the artist's own profileId, see NotificationDoc's own
// SP7 comment). A ref-backed cache (not state) so a row that re-renders for
// an unrelated reason (e.g. its own `read` flag flipping) never re-fetches a
// handle it already resolved; the state pair alongside it exists only to
// trigger the ONE re-render once that single lookup actually resolves.
function useProfileHandle(profileId: string | null): string | null {
  const cache = useRef<Map<string, string | null>>(new Map());
  const [handle, setHandle] = useState<string | null>(null);
  // Every actual setHandle call below runs inside a .then()/.catch()
  // callback, never synchronously in the effect body itself
  // (eslint-config-next's React Compiler rules flag the latter, same
  // tradeoff ShowsList.tsx's own identical comment documents): even the
  // cache-hit path resolves through Promise.resolve().then(...) rather than
  // calling setHandle directly, so a row whose profileId is already cached
  // still only ever updates state from a callback.
  useEffect(() => {
    if (!profileId) return; // initial state is already null; nothing to set
    let cancelled = false;
    const cached = cache.current.get(profileId);
    const lookup = cached !== undefined
      ? Promise.resolve(cached)
      : getDoc(doc(getFirebase().db, "profiles", profileId))
        .then((snap) => {
          const h = snap.exists() ? ((snap.data() as ProfileDoc).handle ?? null) : null;
          cache.current.set(profileId, h);
          return h;
        })
        .catch(() => null);
    lookup.then((h) => { if (!cancelled) setHandle(h); });
    return () => { cancelled = true; };
  }, [profileId]);
  return handle;
}

// One notification row, split out of NotificationsList's own map body so
// useProfileHandle (a hook, rules-of-hooks bound) has a component of its own
// to live in: only the "new_music" kind ever calls it (a null profileId for
// every other kind is a no-op, see the hook's own early return), but the
// hook still has to run unconditionally on every row per those rules.
function NotificationListRow({ n, markRead }: { n: NotificationRow; markRead: (id: string) => void }) {
  // SP4 Task 10: a "booking" notification carries refId (the bookingId, see
  // Task 10a's NotificationDoc.refId plumbing) once it was written after
  // that field existed; a booking-kind row written before then (or,
  // defensively, any other kind with no route of its own) has no refId and
  // renders as plain text, same as before.
  // SP7 Task 9: show_announced/show_rescheduled/show_post all carry refId =
  // the eventId, straight to the public event page; new_music carries the
  // artist's own profileId instead, resolved to a handle above.
  const artistHandle = useProfileHandle(n.kind === "new_music" ? (n.refId ?? null) : null);
  const isEventKind = n.kind === "show_announced" || n.kind === "show_rescheduled" || n.kind === "show_post";
  const href = isEventKind && n.refId ? `/e/${n.refId}`
    : n.kind === "new_music" && artistHandle ? `/u/${artistHandle}`
    : n.kind === "booking" && n.refId ? `/dashboard/bookings/${n.refId}`
    : null;
  const rowBody = (
    <>
      <span
        className={cn("mt-1.5 size-2 shrink-0 rounded-full bg-gk-accent", n.read && "invisible")}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className={cn("block font-sora text-sm font-semibold", n.read ? "text-gk-muted" : "text-gk-text")}>
          {n.title}
        </span>
        <span className="mt-0.5 block font-sora text-sm text-gk-muted">{n.body}</span>
        <span className="mt-1 block font-sora text-xs text-gk-muted">
          {new Date(n.createdAt).toLocaleString()}
        </span>
      </span>
    </>
  );
  return (
    <li>
      {href ? (
        // Next <Link> (client-side nav), not a plain <a>: a full-document
        // navigation can abort the in-flight markRead() updateDoc before it
        // lands (Task 10 review). Client-side routing lets the write
        // complete regardless of the nav.
        <Link href={href} onClick={() => markRead(n.id)} className="flex gap-3 p-5 hover:bg-gk-border/20">
          {rowBody}
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => markRead(n.id)}
          className="flex w-full gap-3 p-5 text-left hover:bg-gk-border/20"
        >
          {rowBody}
        </button>
      )}
    </li>
  );
}

// Same rationale as ProfilesList above: owns the notifications subscription for exactly
// one signed-in uid, remounted via key={user.uid} by Dashboard so `notes` resets on
// identity change instead of a setState-in-effect reset. Web has no background push
// (deliberately deferred, see task 13 notes); this realtime inbox is the only surface.
function NotificationsList({ uid }: { uid: string }) {
  const [notes, setNotes] = useState<NotificationRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const unsubscribe = onSnapshot(
      query(collection(db, `users/${uid}/notifications`), orderBy("createdAt", "desc"), limit(30)),
      (snap) => {
        if (cancelled) return;
        setNotes(snap.docs.map((d) => ({ id: d.id, ...(d.data() as NotificationDoc) })));
        setLoaded(true);
      });
    return () => { cancelled = true; unsubscribe(); };
  }, [uid]);
  const markRead = (id: string) =>
    updateDoc(doc(getFirebase().db, `users/${uid}/notifications/${id}`), { read: true });

  if (!loaded) {
    return (
      <div className="divide-y divide-gk-border overflow-hidden rounded-gk border border-gk-border bg-gk-surface" role="status" aria-label="Loading notifications">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3 p-5">
            <Skeleton className="mt-1.5 size-2 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (notes.length === 0) {
    return (
      <div className="rounded-gk border border-gk-border bg-gk-surface px-6 py-8 text-center">
        <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
          <IconBell size={20} aria-hidden="true" />
        </span>
        <p className="mt-3 font-syne text-base font-semibold text-gk-text">All caught up</p>
        <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
          Review updates and booking activity will land here the moment they happen. In the meantime,
          go see what&apos;s playing.
        </p>
        <Button asChild variant="link" className="mt-2 h-auto p-0">
          <Link href="/gigs">Browse gigs</Link>
        </Button>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-gk-border overflow-hidden rounded-gk border border-gk-border bg-gk-surface">
      {notes.map((n) => <NotificationListRow key={n.id} n={n} markRead={markRead} />)}
    </ul>
  );
}

// Quiet entry point into /admin (Task 12's page) for the accounts that carry
// the `admin` custom claim, using the exact same claim check
// app/admin/AdminGate.tsx already gates that route with. This component reads
// no admin data and writes nothing: it only decides whether to show a link to
// a route that already exists. Non-admins render nothing, matching /admin's
// own "invisible to non-admins" design (spec section 5) rather than
// advertising a page most visitors can't open.
function AdminEntry() {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    user?.getIdTokenResult().then((t) => { if (!cancelled) setIsAdmin(t.claims.admin === true); });
    return () => { cancelled = true; };
  }, [user]);
  if (!isAdmin) return null;
  return (
    <Link href="/admin" className="font-sora text-sm text-gk-muted hover:text-gk-text">
      Admin
    </Link>
  );
}

export default function Dashboard() {
  const { user, loading, signOutUser } = useAuth();
  const router = useRouter();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);

  if (loading) {
    return (
      <main className="flex items-center justify-center px-4 py-16">
        <p className="font-sora text-sm text-gk-muted">Loading…</p>
      </main>
    );
  }
  if (!user) return null; // redirecting via the effect above

  const deleteAccount = async () => {
    if (!window.confirm("This permanently deletes your account and data. Continue?")) return;
    try {
      setDeleteError(null);
      await httpsCallable(getFirebase().functions, "deleteAccount")({});
      // Navigate away first: this unmounts Dashboard (and its auth-guard
      // effect above), so that effect can't race signOutUser() below and
      // redirect to /sign-in first, landing the user somewhere other than
      // "/". The callable already deleted the auth user server-side; sign
      // out locally afterward so client state doesn't depend on
      // onAuthStateChanged noticing the now-invalid token on its own.
      router.push("/");
      await signOutUser();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Couldn't delete your account. Try again.");
    }
  };

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Dashboard</h1>
      <p className="mt-2 font-sora text-sm text-gk-muted">Your profiles, and anything that needs a look.</p>

      <section className="mt-8">
        <h2 className="font-syne text-lg font-semibold text-gk-text">Your profiles</h2>
        {/* Pre-existing bug fixed in passing (found live during this task's
            browser walkthrough, not introduced by it, see git blame): both
            keys were bare `user.uid`, and React key uniqueness is checked
            across ALL of a parent's children, not just same-type siblings:
            two elements sharing a key is exactly the "two children with the
            same key" console error this threw. Prefixing per component keeps
            each unique while still forcing the same identity-switch remount
            on sign-out/sign-in this key was already here for. */}
        <div className="mt-3">
          <ProfilesList key={`profiles-${user.uid}`} uid={user.uid} />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-syne text-lg font-semibold text-gk-text">Notifications</h2>
        <div className="mt-3">
          <NotificationsList key={`notifications-${user.uid}`} uid={user.uid} />
        </div>
      </section>

      <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-gk-border pt-6">
        <Link
          href="/dashboard/earnings"
          className="inline-flex items-center gap-1.5 font-sora text-sm text-gk-muted hover:text-gk-text"
        >
          <IconEarnings size={16} aria-hidden="true" />
          Earnings &amp; payouts
        </Link>
        <AdminEntry />
      </div>

      {/* Sign out moved into the shell's account/switcher menu (sub-project
          9A task 3): this page keeps only the account action the shell
          doesn't cover, since account deletion is a deliberate, page-level
          action rather than everyday nav chrome. Kept quiet, at the very
          bottom, separated from everything a visit here is actually for. */}
      <div className="mt-6 border-t border-gk-border pt-6">
        <p className="font-sora text-sm text-gk-muted">
          Deleting your account permanently removes it and everything tied to it. There&apos;s no undo.
          Tickets to upcoming events, open transfers, and orders in progress block deletion until they resolve.
        </p>
        <Button
          type="button"
          variant="link"
          className="mt-2 h-auto p-0 text-gk-destructive"
          onClick={deleteAccount}
        >
          Delete account
        </Button>
        {deleteError && (
          <p role="alert" className="mt-3 flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
            <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {deleteError}
          </p>
        )}
      </div>
    </main>
  );
}
