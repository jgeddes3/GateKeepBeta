"use client";
import { useEffect, useState, useRef } from "react";
import {
  collection, collectionGroup, query, where, onSnapshot, orderBy, limit, getDoc, getDocs, doc,
  type DocumentReference,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getDownloadURL, ref as storageRef } from "firebase/storage";
import { getFirebase } from "../../src/lib/firebase";
import { AdminGate } from "./AdminGate";
import type { ProfileDoc, AuditLogDoc, UserDoc, TrackDoc } from "@gatekeep/shared";

type Row<T> = T & { id: string };

// Owns the Approve/Reject actions (and their in-flight/error state) for
// exactly one queue row. A per-row component — rather than a shared
// in-flight-ids array on Queue — keeps the busy flag local state instead of
// a setState update derived from an effect, matching the keyed-component
// reset pattern used elsewhere in this app (dashboard's ProfilesList,
// AdminGate's ClaimCheck).
function QueueRow({ p }: { p: Row<ProfileDoc> }) {
  const [busy, setBusy] = useState(false);
  const review = async (decision: "approved" | "rejected") => {
    const reason = decision === "rejected"
      ? window.prompt("Rejection reason (shown to the applicant):") ?? "" : undefined;
    if (decision === "rejected" && !reason) return;
    setBusy(true);
    try {
      const { functions } = getFirebase();
      await httpsCallable(functions, "reviewProfile")({ profileId: p.id, decision, reason });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not submit the review — try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ border: "1px solid #ddd", padding: 12, marginBottom: 8 }}>
      <strong>{p.name}</strong> @{p.handle} — {p.type} ({p.subtype})
      <div>
        <button disabled={busy} onClick={() => review("approved")}>Approve</button>{" "}
        <button disabled={busy} onClick={() => review("rejected")}>Reject…</button>
      </div>
    </div>
  );
}

function Queue() {
  const [pending, setPending] = useState<Row<ProfileDoc>[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "profiles"), where("status", "==", "pending_review")),
      (s) => setPending(s.docs.map((d) => ({ id: d.id, ...(d.data() as ProfileDoc) }))),
    );
  }, []);
  return (
    <section>
      <h2>Approvals queue ({pending.length})</h2>
      {/* Review checklist per spec §6: shown to the reviewing admin, not just a code comment. */}
      <p style={{ background: "#fff8e1", border: "1px solid #f0d878", padding: "8px 12px", borderRadius: 4 }}>
        Before approving: verify this is really them — check the name, handle, and submitted
        details for impersonation.
      </p>
      {pending.map((p) => <QueueRow key={p.id} p={p} />)}
      {pending.length === 0 && <p>Nothing waiting.</p>}
    </section>
  );
}

type TrackRow = Row<TrackDoc> & { profileId: string; profileName: string };

// Owns the Approve/Reject actions for exactly one pending track — same
// per-row-busy-state rationale as QueueRow above. Also resolves and plays the
// review clip inline (spec §6: admin listens before approving), via
// getDownloadURL on the track's review/... storagePath — admins can read any
// review clip under storage.rules. url is three-state: null while resolving
// (loading placeholder), "error" if getDownloadURL rejects (e.g. the object
// is missing — surfaced as an explicit dead-end rather than an infinite
// "clip loading…", since nothing will ever move it out of that state), or
// the resolved string. storagePath is typed nullable on TrackDoc (other
// statuses can have no file yet); the transcode trigger only ever writes
// status:"pending_review" and storagePath together in the same update, so in
// practice every row here has one, but the effect still guards against a
// falsy path rather than assuming that invariant.
function TrackQueueRow({ t }: { t: TrackRow }) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null | "error">(null);
  useEffect(() => {
    if (!t.storagePath) return;
    let cancelled = false;
    void getDownloadURL(storageRef(getFirebase().storage, t.storagePath))
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch((e) => {
        console.error("TrackQueueRow: getDownloadURL failed", t.storagePath, e);
        if (!cancelled) setUrl("error");
      });
    return () => { cancelled = true; };
  }, [t.storagePath]);
  const review = async (decision: "approved" | "rejected") => {
    const reason = decision === "rejected"
      ? window.prompt("Rejection reason (shown to the musician):") ?? "" : undefined;
    if (decision === "rejected" && !reason) return;
    setBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "reviewTrack")(
        { profileId: t.profileId, trackId: t.id, decision, reason });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not submit the review — try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ border: "1px solid #ddd", padding: 12, marginBottom: 8 }}>
      <strong>{t.title}</strong> — {t.profileName} · {t.durationSec ?? "?"}s
      {t.storagePath == null
        ? <p style={{ color: "#888" }}>No clip on file.</p>
        : url === "error"
          ? <p style={{ color: "#b00020" }}>Clip unavailable — reject and ask the musician to re-upload.</p>
          : url
            ? <audio controls preload="none" src={url} style={{ display: "block", margin: "8px 0" }} />
            : <p style={{ color: "#888" }}>clip loading…</p>}
      <button disabled={busy} onClick={() => review("approved")}>Approve</button>{" "}
      <button disabled={busy} onClick={() => review("rejected")}>Reject…</button>
    </div>
  );
}

// Pending-track review queue (spec §6). collectionGroup('tracks') mirrors
// Queue's flat collection query above, but tracks live under
// profiles/{profileId}/tracks — collectionGroup + the admin CG-read rule and
// fieldOverride index (already in place) is what makes a single
// cross-profile "everything pending" listener possible. Bounded with
// limit(100), same reasoning as AuditLog's limit(50): an admin listener
// should never fan out unboundedly. This intentionally doesn't order by
// createdAt (i.e. isn't FIFO-oldest-first) — collectionGroup + an equality
// filter + orderBy on a different field needs its own composite index,
// which doesn't exist yet; deferred until the queue realistically nears
// this cap and ordering starts to matter.
//
// Each snapshot also resolves the parent profile doc for its name
// (deleted-profile-safe, same "(deleted)" fallback the mobile/web
// dashboards use elsewhere) — batched via Promise.all over the *unique*
// profile ids in this snapshot (several pending tracks routinely share a
// profile), not one sequential getDoc per track. Two race guards on top of
// that N+1 resolution, since it's async work hanging off a listener that
// can fire again before it finishes: `cancelled` (composed into the
// cleanup, same convention as UserProfiles below) for unmount, and a
// monotonic `seq` token so a slower, older snapshot's resolution can never
// finish after and repaint over a newer one's already-committed state.
function TracksQueue() {
  const [pending, setPending] = useState<TrackRow[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    let cancelled = false;
    let seq = 0;
    const unsubscribe = onSnapshot(
      query(collectionGroup(db, "tracks"), where("status", "==", "pending_review"), limit(100)),
      async (s) => {
        const mySeq = ++seq;
        const profileRefs = new Map<string, DocumentReference>();
        for (const d of s.docs) {
          const profileRef = d.ref.parent.parent;
          if (!profileRef) continue;
          profileRefs.set(profileRef.id, profileRef);
        }
        const nameEntries = await Promise.all(
          Array.from(profileRefs.values()).map(async (profileRef) => {
            const p = await getDoc(profileRef);
            return [profileRef.id, p.exists() ? (p.data() as ProfileDoc).name : "(deleted)"] as const;
          }),
        );
        if (cancelled || mySeq !== seq) return;
        const names = new Map(nameEntries);
        const rows: TrackRow[] = [];
        for (const d of s.docs) {
          const profileRef = d.ref.parent.parent;
          if (!profileRef) continue;
          rows.push({
            id: d.id,
            profileId: profileRef.id,
            profileName: names.get(profileRef.id) ?? "(deleted)",
            ...(d.data() as TrackDoc),
          });
        }
        setPending(rows);
      },
    );
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  return (
    <section>
      <h2>Track review queue ({pending.length})</h2>
      {/* Screening guidance per spec §6: admins hear exactly what the public would. */}
      <p style={{ background: "#fff8e1", border: "1px solid #f0d878", padding: "8px 12px", borderRadius: 4 }}>
        You are hearing exactly what the public would hear. Screening call: does this
        sound like the artist&apos;s own performance (not AI-generated / not someone
        else&apos;s recording)? When unsure, reject with a note asking for context.
      </p>
      {pending.map((t) => <TrackQueueRow key={`${t.profileId}-${t.id}`} t={t} />)}
      {pending.length === 0 && <p>Nothing waiting.</p>}
    </section>
  );
}

// Retroactive-takedown panel (spec §6: "admins can retroactively unpublish").
// reviewTrack already accepts decision:"rejected" against an already-approved
// track — TracksQueue above can't reach that path since it only ever lists
// pending_review tracks, so this gives admins a way in: look a profile up by
// handle, see its live (approved) tracks, remove one with a reason. Same
// handles/{handle} -> profileId indirection the public /u/[handle] route
// uses, and handles are stored lowercase there too.
function TakedownsPanel() {
  const [handle, setHandle] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Row<TrackDoc>[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Track ids whose most recent removal attempt committed the reject
  // server-side but then hit reviewTrack's "unavailable" (public clip
  // couldn't be deleted) — see the remove() catch below for why these stay
  // in `tracks` and get a visible marker instead of disappearing.
  const [incompleteIds, setIncompleteIds] = useState<Set<string>>(new Set());
  // Guards lookup() the same way TracksQueue's `seq` guards its snapshot
  // handler: the Enter-key handler and the Look-up button both call
  // lookup(), and disabling on lookupBusy narrows but doesn't fully close
  // the window for a second call to start before React commits the first's
  // setLookupBusy(true) (both can read the same stale closure mid-event). A
  // ref (not state — needs to be readable synchronously the instant a
  // response resolves) means a slower, superseded lookup's response can
  // never overwrite a newer one's already-displayed results.
  const lookupSeq = useRef(0);

  const lookup = async () => {
    const h = handle.trim().toLowerCase();
    if (!h) return;
    const mySeq = ++lookupSeq.current;
    setLookupBusy(true);
    // Clear any previous handle's results up front, so a failed lookup (or a
    // slow one) never leaves a stale profile's tracks on screen under a new
    // handle in the input.
    setProfileId(null);
    setTracks([]);
    setIncompleteIds(new Set());
    try {
      const { db } = getFirebase();
      const handleDoc = await getDoc(doc(db, "handles", h));
      if (mySeq !== lookupSeq.current) return; // superseded by a newer lookup
      if (!handleDoc.exists()) { window.alert("No profile with that handle."); return; }
      const pid = (handleDoc.data() as { profileId: string }).profileId;
      const snap = await getDocs(query(
        collection(db, `profiles/${pid}/tracks`), where("status", "==", "approved"), orderBy("order")));
      if (mySeq !== lookupSeq.current) return; // superseded by a newer lookup
      setProfileId(pid);
      setTracks(snap.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) })));
    } catch (e) {
      if (mySeq === lookupSeq.current) {
        window.alert(e instanceof Error ? e.message : "Could not look up that handle — try again.");
      }
    } finally {
      if (mySeq === lookupSeq.current) setLookupBusy(false);
    }
  };

  const remove = async (trackId: string) => {
    if (!profileId) return;
    const reason = window.prompt(
      "Takedown reason (shown to the musician) — this removes the track from their live profile immediately:",
    ) ?? "";
    if (!reason) return;
    setBusyId(trackId);
    try {
      await httpsCallable(getFirebase().functions, "reviewTrack")(
        { profileId, trackId, decision: "rejected", reason });
      setTracks((ts) => ts.filter((t) => t.id !== trackId));
      setIncompleteIds((ids) => { const next = new Set(ids); next.delete(trackId); return next; });
    } catch (e) {
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
      if (code === "functions/unavailable") {
        // reviewTrack already committed "rejected" before throwing this —
        // the decision is final at the transaction, storage cleanup runs
        // after (see that function's comments) — so the public object may
        // still be reachable even though the doc says rejected. Don't
        // filter the row out: a fresh lookup queries status=="approved",
        // which this doc no longer matches, so re-looking-up would just
        // silently drop the row and hide an incomplete takedown. Mark it
        // instead, so the admin sees it needs a retry rather than assuming
        // it's still an ordinary live track.
        setIncompleteIds((ids) => new Set(ids).add(trackId));
      } else {
        window.alert(e instanceof Error ? e.message : "Could not remove the track — try again.");
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section>
      <h2>Takedowns</h2>
      <p>Retroactively remove a live track from an approved profile (spec §6).</p>
      <input
        placeholder="@handle"
        value={handle}
        onChange={(e) => setHandle(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !lookupBusy) void lookup(); }}
      />{" "}
      <button disabled={lookupBusy} onClick={lookup}>{lookupBusy ? "Looking up…" : "Look up"}</button>
      {tracks.map((t) => (
        <div key={t.id} style={{ border: "1px solid #ddd", padding: 12, marginTop: 8 }}>
          <strong>{t.title}</strong> · {t.durationSec ?? "?"}s
          {incompleteIds.has(t.id) && (
            <p style={{ color: "#b00020", margin: "4px 0" }}>
              Removal incomplete — retry. (The track is already off review, but the public
              clip may still be reachable.)
            </p>
          )}
          <div>
            <button disabled={busyId === t.id} onClick={() => remove(t.id)}>
              {busyId === t.id ? "Removing…" : incompleteIds.has(t.id) ? "Retry removal…" : "Remove…"}
            </button>
          </div>
        </div>
      ))}
      {profileId && tracks.length === 0 && <p>No approved tracks.</p>}
    </section>
  );
}

// Loads and displays one user's profiles + statuses (spec §6: "profiles and
// statuses"), via the same collectionGroup('members').where('uid', ...)
// pattern the mobile/web dashboards use for "my profiles" — admins can read
// any uid's membership docs this way (firestore.rules grants isAdmin() the
// same collection-group access as the self-read clause).
function UserProfiles({ uid }: { uid: string }) {
  const [profiles, setProfiles] = useState<Row<ProfileDoc>[] | "loading">("loading");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { db } = getFirebase();
      const memberships = await getDocs(query(collectionGroup(db, "members"), where("uid", "==", uid)));
      const out: Row<ProfileDoc>[] = [];
      for (const m of memberships.docs) {
        if (cancelled) return;
        const profileRef = m.ref.parent.parent;
        if (!profileRef) continue;
        const p = await getDoc(profileRef);
        if (cancelled) return;
        if (p.exists()) out.push({ id: p.id, ...(p.data() as ProfileDoc) });
      }
      if (!cancelled) setProfiles(out);
    })();
    return () => { cancelled = true; };
  }, [uid]);
  if (profiles === "loading") return <p style={{ margin: "4px 0 0 16px", fontSize: 14 }}>Loading profiles…</p>;
  if (profiles.length === 0) return <p style={{ margin: "4px 0 0 16px", fontSize: 14 }}>No profiles.</p>;
  return (
    <ul style={{ margin: "4px 0 0 16px", fontSize: 14 }}>
      {profiles.map((p) => <li key={p.id}>{p.name} — {p.type} — {p.status.replace("_", " ")}</li>)}
    </ul>
  );
}

function UserLookup() {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<Row<UserDoc>[]>([]);
  const search = async () => {
    const { db } = getFirebase();
    const s = await getDocs(query(collection(db, "users"), where("email", "==", term.trim())));
    setResults(s.docs.map((d) => ({ id: d.id, ...(d.data() as UserDoc) })));
  };
  return (
    <section>
      <h2>User lookup</h2>
      {/* v1: exact-email lookup only. Name search is deferred — no name index/normalization
          exists yet, and this dashboard's other surfaces (queue, audit log) cover the
          near-term admin workflows without it. */}
      <input placeholder="exact email" value={term} onChange={(e) => setTerm(e.target.value)} />
      <button onClick={search}>Search</button>
      {results.map((u) => (
        <div key={u.id} style={{ marginBottom: 8 }}>
          <p style={{ margin: 0 }}>{u.displayName} · {u.email} · uid {u.id}</p>
          <UserProfiles key={u.id} uid={u.id} />
        </div>
      ))}
      {results.length === 0 && term && <p>No match.</p>}
    </section>
  );
}

function AuditLog() {
  const [logs, setLogs] = useState<Row<AuditLogDoc>[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "auditLogs"), orderBy("at", "desc"), limit(50)),
      (s) => setLogs(s.docs.map((d) => ({ id: d.id, ...(d.data() as AuditLogDoc) }))),
    );
  }, []);
  return (
    <section>
      <h2>Audit log</h2>
      {logs.map((l) => (
        <p key={l.id}>{new Date(l.at).toLocaleString()} — {l.action} — target {l.targetId} — by {l.actorUid} {l.detail && `— ${l.detail}`}</p>
      ))}
      {logs.length === 0 && <p>No activity yet.</p>}
    </section>
  );
}

export default function AdminPage() {
  return (
    <AdminGate>
      <main style={{ maxWidth: 860, margin: "40px auto", display: "grid", gap: 32 }}>
        <h1>GateKeep Admin</h1>
        <Queue /><TracksQueue /><TakedownsPanel /><UserLookup /><AuditLog />
      </main>
    </AdminGate>
  );
}
