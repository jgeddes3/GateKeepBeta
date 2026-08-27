"use client";
import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, orderBy, query, where, type QueryConstraint } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { GENRES, type GigDoc, type BudgetStructure } from "@gatekeep/shared";
import { formatGigDateTime, formatCents, BUDGET_STRUCTURE_LABEL, badge, chip, endDateInputToUtcMs } from "../gigs/GigForms";
import { formatDuration, gigLocationLabel } from "./BookingForms";

type GigRow = GigDoc & { id: string };
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function GigCard({ gig }: { gig: GigRow }) {
  return (
    <li style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, display: "grid", gap: 6 }}>
      <a href={`/gigs/${gig.id}`}><strong>{gig.title || "Untitled gig"}</strong></a>
      <p style={{ margin: 0, color: "#666", fontSize: 14 }}>
        {formatGigDateTime(gig.startsAt)} · {formatDuration(gig.durationMinutes)}
      </p>
      <p style={{ margin: 0, fontSize: 14 }}>
        {formatCents(gig.budget.minCents)}–{formatCents(gig.budget.maxCents)} {BUDGET_STRUCTURE_LABEL[gig.budget.structure]}
      </p>
      {(gig.wants.genres.length > 0 || gig.wants.actSizes.length > 0) && (
        <p style={{ margin: 0, color: "#666", fontSize: 14 }}>
          Looking for: {[gig.wants.genres.join(", "), gig.wants.actSizes.join(", ")].filter(Boolean).join(" · ")}
        </p>
      )}
      <p style={{ margin: 0, color: "#666", fontSize: 14 }}>{gigLocationLabel(gig.location)}</p>
      {gig.seriesId != null && (
        // Softer copy, deliberately not naming fillMode — gigSeries docs are
        // member-only (firestore.rules), so this public browse page can
        // never prove whether the run books whole or per-occurrence.
        // Controller-sanctioned resolution for this task: no n+1 gigSeries
        // fetch here; the gig detail page shows exact fill semantics, and
        // only when the viewer can actually read the series doc.
        <span style={{ ...badge("#e0e7ff"), width: "fit-content" }}>Part of a recurring series</span>
      )}
    </li>
  );
}

// Public "Find gigs" browse — status=="open" ordered startsAt is the one
// query shape firestore.rules can prove for an anonymous caller (see
// firestore.rules' gigs read rule + tests-rules/rules.test.ts). City/genre/
// structure are pure client-side filters over that result; the date range
// is the only filter mapped onto the query itself, as a range on the
// already-indexed startsAt field (gigs(status,startsAt) — no new index
// needed). Placeholder-grade per spec §1 — sub-8 replaces the internals
// with real server-side search.
export function GigBrowse() {
  const [gigs, setGigs] = useState<GigRow[] | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [city, setCity] = useState("");
  const [genre, setGenre] = useState<string | null>(null);
  const [structure, setStructure] = useState<BudgetStructure | "any">("any");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  // No synchronous "loading"/error reset at the top of the effect (that
  // pattern is what eslint-config-next's React Compiler rules flag as
  // set-state-in-effect) — every state transition here happens inside
  // getDocs' own success/failure callback instead. A filter change (from/to
  // date) therefore keeps showing the PREVIOUS result set until the new
  // query resolves, rather than flashing back to a bare "Loading…" —
  // acceptable, even preferable, UX for a fast local/emulator query.
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const constraints: QueryConstraint[] = [where("status", "==", "open")];
    const fromMs = endDateInputToUtcMs(fromDate);
    const toMs = endDateInputToUtcMs(toDate);
    if (fromMs != null) constraints.push(where("startsAt", ">=", fromMs));
    if (toMs != null) constraints.push(where("startsAt", "<", toMs + ONE_DAY_MS));
    constraints.push(orderBy("startsAt"));
    getDocs(query(collection(db, "gigs"), ...constraints))
      .then((snap) => {
        if (cancelled) return;
        setGigs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) })));
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setGigs([]);
        setError(e instanceof Error ? e.message : "Could not load gigs.");
      });
    return () => { cancelled = true; };
  }, [fromDate, toDate]);

  const filtered = useMemo(() => {
    if (gigs === "loading") return [];
    const cityLower = city.trim().toLowerCase();
    return gigs.filter((g) =>
      (cityLower === "" || g.location.city.toLowerCase().includes(cityLower))
      && (genre === null || g.wants.genres.includes(genre))
      && (structure === "any" || g.budget.structure === structure));
  }, [gigs, city, genre, structure]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gap: 8 }}>
        <input placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} style={{ maxWidth: 240 }} />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setGenre(null)} style={chip(genre === null)}>All genres</button>
          {GENRES.map((g) => (
            <button key={g} type="button" onClick={() => setGenre(genre === g ? null : g)} style={chip(genre === g)}>{g}</button>
          ))}
        </div>
        <label>Structure:{" "}
          <select value={structure} onChange={(e) => setStructure(e.target.value as BudgetStructure | "any")}>
            <option value="any">Any</option>
            <option value="perHour">per hour</option>
            <option value="perSong">per song</option>
            <option value="perSet">per set</option>
          </select>
        </label>
        <label>From: <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></label>
        <label>To: <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
      </div>
      {error && (
        <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
          Could not load gigs: {error}
        </p>
      )}
      {gigs === "loading" && <p>Loading…</p>}
      {gigs !== "loading" && filtered.length === 0 && !error && <p style={{ color: "#666" }}>No open gigs match these filters.</p>}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
        {filtered.map((g) => <GigCard key={g.id} gig={g} />)}
      </ul>
    </div>
  );
}
