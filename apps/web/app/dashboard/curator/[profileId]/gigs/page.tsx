"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, onSnapshot, collection, query, where } from "firebase/firestore";
import { getFirebase } from "../../../../../src/lib/firebase";
import { useAuth } from "../../../../../src/auth/AuthProvider";
import { GIG_STATUS_LABEL, SERIES_STATUS_LABEL, BUDGET_STRUCTURE_LABEL, WEEKDAY_LABELS, badge } from "../../../../../src/gigs/GigForms";
import type { ProfileDoc, GigDoc, GigSeriesDoc } from "@gatekeep/shared";

type GigRow = GigDoc & { id: string };
type SeriesRow = GigSeriesDoc & { id: string };

// taken_down is a MODERATION action (admin-issued, Task 12) — it must not
// read as just another flavor of the curator's own routine cancellation, so
// it gets its own amber/orange pair distinct from cancelled's red, even
// though this task's UI has no takedown action of its own (a gig can still
// arrive here already taken_down).
const STATUS_BG: Record<GigDoc["status"], string> = {
  draft: "#fef9c3", open: "#dcfce7", closed: "#e5e7eb", cancelled: "#fee2e2", taken_down: "#fed7aa",
};
const STATUS_FG: Partial<Record<GigDoc["status"], string>> = { taken_down: "#9a3412" };

function GigListItem({ profileId, gig }: { profileId: string; gig: GigRow }) {
  return (
    <li style={{ border: "1px solid #ddd", borderRadius: 8, padding: 10 }}>
      <a href={`/dashboard/curator/${profileId}/gigs/${gig.id}`}><strong>{gig.title || "Untitled gig"}</strong></a>
      {" "}<span style={badge(STATUS_BG[gig.status], STATUS_FG[gig.status])}>{GIG_STATUS_LABEL[gig.status]}</span>
      <p style={{ margin: "4px 0 0", color: "#666", fontSize: 14 }}>
        {new Date(gig.startsAt).toLocaleString()}
        {" · $"}{(gig.budget.minCents / 100).toFixed(0)}–${(gig.budget.maxCents / 100).toFixed(0)} {BUDGET_STRUCTURE_LABEL[gig.budget.structure]}
        {gig.seriesId && (
          <> · <a href={`/dashboard/curator/${profileId}/series/${gig.seriesId}`}>series</a>{gig.detachedFromTemplate ? " (detached)" : ""}</>
        )}
      </p>
    </li>
  );
}

// Sorted ascending (soonest first) for open/drafts — "what's coming up" is
// the useful question there — and descending (most recent first) for the
// past group, where "what just happened" matters more.
const byStartsAtAsc = (a: GigRow, b: GigRow) => a.startsAt - b.startsAt;
const byStartsAtDesc = (a: GigRow, b: GigRow) => b.startsAt - a.startsAt;

export default function GigsList(props: { params: Promise<{ profileId: string }> }) {
  const { profileId } = use(props.params);
  const { user, loading } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileDoc | null | "loading">("loading");
  const [gigs, setGigs] = useState<GigRow[]>([]);
  const [series, setSeries] = useState<SeriesRow[]>([]);

  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", profileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null),
      () => setProfile(null));
  }, [user, profileId]);
  // where(curatorProfileId=='X') with NO status filter — rules-provable for
  // a member via the member disjunct alone (see firestore.rules' comment on
  // gigs' read rule + tests-rules/rules.test.ts's "curator dashboard" test),
  // regardless of each doc's actual status, and needs no composite index
  // (single equality field). Every status comes back in one listener; the
  // open/drafts/past grouping below is purely client-side.
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "gigs"), where("curatorProfileId", "==", profileId)),
      (s) => setGigs(s.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) }))));
  }, [user, profileId]);
  // Same shape for gigSeries — its read rule (isMember(curatorProfileId) ||
  // isAdmin(), no public disjunct) is provable the identical way.
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "gigSeries"), where("curatorProfileId", "==", profileId)),
      (s) => setSeries(s.docs.map((d) => ({ id: d.id, ...(d.data() as GigSeriesDoc) }))));
  }, [user, profileId]);

  if (loading || !user || profile === "loading") return <main><p>Loading…</p></main>;
  if (!profile || profile.type !== "curator") return <main><p>No curator profile here.</p></main>;

  const open = gigs.filter((g) => g.status === "open").sort(byStartsAtAsc);
  const drafts = gigs.filter((g) => g.status === "draft").sort(byStartsAtAsc);
  const past = gigs.filter((g) => g.status === "closed" || g.status === "cancelled" || g.status === "taken_down").sort(byStartsAtDesc);

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", display: "grid", gap: 24 }}>
      <a href={`/dashboard/curator/${profileId}`} style={{ color: "#666", fontSize: 14 }}>← {profile.name}</a>
      <h1>Gigs & series</h1>
      {profile.status === "approved" ? (
        <a href={`/dashboard/curator/${profileId}/gigs/new`}><button>+ Post a new gig</button></a>
      ) : (
        <p style={{ color: "#666" }}>Your curator profile must be approved before you can post gigs.</p>
      )}

      <section style={{ display: "grid", gap: 8 }}>
        <h2>Open ({open.length})</h2>
        {open.length === 0 && <p style={{ color: "#666" }}>No open gigs.</p>}
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {open.map((g) => <GigListItem key={g.id} profileId={profileId} gig={g} />)}
        </ul>
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <h2>Drafts ({drafts.length})</h2>
        {drafts.length === 0 && <p style={{ color: "#666" }}>No drafts.</p>}
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {drafts.map((g) => <GigListItem key={g.id} profileId={profileId} gig={g} />)}
        </ul>
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <h2>Past & closed ({past.length})</h2>
        {past.length === 0 && <p style={{ color: "#666" }}>Nothing here yet.</p>}
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {past.map((g) => <GigListItem key={g.id} profileId={profileId} gig={g} />)}
        </ul>
      </section>

      <section style={{ display: "grid", gap: 8, borderTop: "1px solid #eee", paddingTop: 16 }}>
        <h2>Series ({series.length})</h2>
        {series.length === 0 && <p style={{ color: "#666" }}>No recurring series yet.</p>}
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {series.map((s) => (
            <li key={s.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 10 }}>
              <a href={`/dashboard/curator/${profileId}/series/${s.id}`}><strong>{s.template.title || "Untitled series"}</strong></a>
              {" "}<span style={badge("#e0e7ff")}>{SERIES_STATUS_LABEL[s.status]}</span>
              <p style={{ margin: "4px 0 0", color: "#666", fontSize: 14 }}>
                {WEEKDAY_LABELS[s.recurrence.weekday]}s, {String(s.recurrence.hour).padStart(2, "0")}:{String(s.recurrence.minute).padStart(2, "0")}, {s.recurrence.cadence}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
