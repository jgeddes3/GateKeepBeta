"use client";
import { useEffect, useState } from "react";
import {
  collection, collectionGroup, query, where, onSnapshot, orderBy, limit, getDoc, getDocs,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../src/lib/firebase";
import { AdminGate } from "./AdminGate";
import type { ProfileDoc, AuditLogDoc, UserDoc } from "@gatekeep/shared";

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
        <Queue /><UserLookup /><AuditLog />
      </main>
    </AdminGate>
  );
}
