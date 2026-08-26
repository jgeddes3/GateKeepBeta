"use client";
import { useEffect, useState } from "react";
import {
  collection, collectionGroup, query, where, onSnapshot, orderBy, limit, getDoc, getDocs, doc,
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
// review clip under storage.rules. url stays null (and the row shows a
// loading placeholder) until that resolves or fails. storagePath is typed
// nullable on TrackDoc (other statuses can have no file yet); the transcode
// trigger only ever writes status:"pending_review" and storagePath together
// in the same update, so in practice every row here has one, but the effect
// still guards against a falsy path rather than assuming that invariant.
function TrackQueueRow({ t }: { t: TrackRow }) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!t.storagePath) return;
    let cancelled = false;
    void getDownloadURL(storageRef(getFirebase().storage, t.storagePath))
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch(() => { if (!cancelled) setUrl(null); });
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
        : url
          ? <audio controls src={url} style={{ display: "block", margin: "8px 0" }} />
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
// cross-profile "everything pending" listener possible. Each snapshot also
// resolves the parent profile doc for its name (deleted-profile-safe, same
// "(deleted)" fallback the mobile/web dashboards use elsewhere).
function TracksQueue() {
  const [pending, setPending] = useState<TrackRow[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collectionGroup(db, "tracks"), where("status", "==", "pending_review")),
      async (s) => {
        const rows: TrackRow[] = [];
        for (const d of s.docs) {
          const profileRef = d.ref.parent.parent!;
          const p = await getDoc(profileRef);
          rows.push({
            id: d.id,
            profileId: profileRef.id,
            profileName: p.exists() ? (p.data() as ProfileDoc).name : "(deleted)",
            ...(d.data() as TrackDoc),
          });
        }
        setPending(rows);
      },
    );
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

  const lookup = async () => {
    const h = handle.trim().toLowerCase();
    if (!h) return;
    setLookupBusy(true);
    // Clear any previous handle's results up front, so a failed lookup (or a
    // slow one) never leaves a stale profile's tracks on screen under a new
    // handle in the input.
    setProfileId(null);
    setTracks([]);
    try {
      const { db } = getFirebase();
      const handleDoc = await getDoc(doc(db, "handles", h));
      if (!handleDoc.exists()) { window.alert("No profile with that handle."); return; }
      const pid = (handleDoc.data() as { profileId: string }).profileId;
      const snap = await getDocs(query(
        collection(db, `profiles/${pid}/tracks`), where("status", "==", "approved"), orderBy("order")));
      setProfileId(pid);
      setTracks(snap.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) })));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not look up that handle — try again.");
    } finally {
      setLookupBusy(false);
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
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not remove the track — try again.");
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
        onKeyDown={(e) => { if (e.key === "Enter") void lookup(); }}
      />{" "}
      <button disabled={lookupBusy} onClick={lookup}>{lookupBusy ? "Looking up…" : "Look up"}</button>
      {tracks.map((t) => (
        <div key={t.id} style={{ border: "1px solid #ddd", padding: 12, marginTop: 8 }}>
          <strong>{t.title}</strong> · {t.durationSec ?? "?"}s
          <div>
            <button disabled={busyId === t.id} onClick={() => remove(t.id)}>
              {busyId === t.id ? "Removing…" : "Remove…"}
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
