"use client";
import { useEffect, useState } from "react";
import {
  collection, query, where, onSnapshot, orderBy, limit, getDocs,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../src/lib/firebase";
import { AdminGate } from "./AdminGate";
import type { ProfileDoc, AuditLogDoc, UserDoc } from "@gatekeep/shared";

type Row<T> = T & { id: string };

function Queue() {
  const [pending, setPending] = useState<Row<ProfileDoc>[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "profiles"), where("status", "==", "pending_review")),
      (s) => setPending(s.docs.map((d) => ({ id: d.id, ...(d.data() as ProfileDoc) }))),
    );
  }, []);
  const review = async (profileId: string, decision: "approved" | "rejected") => {
    const reason = decision === "rejected"
      ? window.prompt("Rejection reason (shown to the applicant):") ?? "" : undefined;
    if (decision === "rejected" && !reason) return;
    const { functions } = getFirebase();
    await httpsCallable(functions, "reviewProfile")({ profileId, decision, reason });
  };
  return (
    <section>
      <h2>Approvals queue ({pending.length})</h2>
      {/* Review checklist per spec §6: verify identity — is this really them? */}
      {pending.map((p) => (
        <div key={p.id} style={{ border: "1px solid #ddd", padding: 12, marginBottom: 8 }}>
          <strong>{p.name}</strong> @{p.handle} — {p.type} ({p.subtype})
          <div>
            <button onClick={() => review(p.id, "approved")}>Approve</button>{" "}
            <button onClick={() => review(p.id, "rejected")}>Reject…</button>
          </div>
        </div>
      ))}
      {pending.length === 0 && <p>Nothing waiting.</p>}
    </section>
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
      <input placeholder="exact email" value={term} onChange={(e) => setTerm(e.target.value)} />
      <button onClick={search}>Search</button>
      {results.map((u) => <p key={u.id}>{u.displayName} · {u.email} · uid {u.id}</p>)}
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
