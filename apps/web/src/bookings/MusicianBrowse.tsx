"use client";
import { useEffect, useMemo, useState } from "react";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { GENRES, type ProfileDoc, type MusicianSubtype, type CuratorBookingDoc, type BudgetStructure } from "@gatekeep/shared";
import { formatCents, BUDGET_STRUCTURE_LABEL, chip } from "../gigs/GigForms";
import { OfferComposer } from "./OfferComposer";

type MusicianRow = ProfileDoc & { id: string };

// MusicianSubtype ("solo"|"band") is the only act-size-shaped field actually
// present on a musician's own profile doc without an extra per-card read —
// BookingPreferences.actSize (the richer solo/duo/band value) only exists
// inside the per-card curatorBooking projection fetched below, and gating
// the FILTER on that would force every card's private read before the list
// could even render. Placeholder-grade per spec §1, same as GigBrowse's
// filters — sub-8 replaces the internals.
const ACT_SIZE_OPTIONS: MusicianSubtype[] = ["solo", "band"];
const ACT_SIZE_LABEL: Record<MusicianSubtype, string> = { solo: "Solo", band: "Band" };
const RATE_STRUCTURES: BudgetStructure[] = ["perHour", "perSong", "perSet"];

function RatesSummary({ rates }: { rates: CuratorBookingDoc["rates"] }) {
  const parts = RATE_STRUCTURES
    .map((k) => (rates[k] ? `${formatCents(rates[k]!.amountCents)} ${BUDGET_STRUCTURE_LABEL[k]}` : null))
    .filter((p): p is string => p !== null);
  if (parts.length === 0) return <p style={{ margin: 0, color: "#666", fontSize: 14 }}>No public rates.</p>;
  return <p style={{ margin: 0, fontSize: 14 }}>{parts.join(" · ")}</p>;
}

function MusicianCard({ curatorProfileId, musician }: { curatorProfileId: string; musician: MusicianRow }) {
  const [booking, setBooking] = useState<CuratorBookingDoc | null | "loading">("loading");
  const [offering, setOffering] = useState(false);

  // Per-card private/curatorBooking read — the caller has curatorAccess via
  // their own approved curator profile membership (firestore.rules'
  // curatorBooking read rule), regardless of curatorProfileId; n+1 over the
  // list is accepted at v1 (spec §1 placeholder grade), same tradeoff as
  // GigBrowse's series-badge decision. No synchronous setBooking("loading")
  // reset here (set-state-in-effect) — musician.id never changes for an
  // already-mounted card (each card is keyed by musician.id one level up in
  // MusicianBrowse, so a different musician is always a fresh mount), and
  // the initial useState("loading") above already covers first render.
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    getDoc(doc(db, `profiles/${musician.id}/private/curatorBooking`))
      .then((s) => { if (!cancelled) setBooking(s.exists() ? (s.data() as CuratorBookingDoc) : null); })
      .catch(() => { if (!cancelled) setBooking(null); });
    return () => { cancelled = true; };
  }, [musician.id]);

  return (
    <li style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, display: "grid", gap: 6 }}>
      <strong>{musician.name}</strong>
      {musician.portfolio?.genres && musician.portfolio.genres.length > 0 && (
        <p style={{ margin: 0, color: "#666", fontSize: 14 }}>{musician.portfolio.genres.join(" · ")}</p>
      )}
      {booking === "loading" ? (
        <p style={{ margin: 0, color: "#999", fontSize: 14 }}>Loading rates…</p>
      ) : booking ? (
        <>
          <RatesSummary rates={booking.rates} />
          {/* Counts BOOKINGS, not dates — an 8-date completed whole-run
              booking is +1 here, not +8 (ReliabilitySummary.completedCount
              is booking-scoped — see functions/src/bookingLifecycle.ts's
              recomputeReliability). */}
          <p style={{ margin: 0, fontSize: 13, color: "#666" }}>
            {booking.reliability.noShowCount} no-shows / {booking.reliability.completedCount} bookings
          </p>
        </>
      ) : (
        <p style={{ margin: 0, color: "#666", fontSize: 14 }}>No booking info shared yet.</p>
      )}
      <p style={{ margin: 0 }}>
        <a href={`/@${musician.handle}`} target="_blank" rel="noopener noreferrer">View portfolio</a>
        {" · "}
        <button type="button" onClick={() => setOffering((v) => !v)}>{offering ? "Cancel" : "Offer a gig"}</button>
      </p>
      {offering && (
        <OfferComposer key={`${curatorProfileId}-${musician.id}`} curatorProfileId={curatorProfileId}
          musicianProfileId={musician.id} musicianName={musician.name} onClose={() => setOffering(false)} />
      )}
    </li>
  );
}

// Find musicians (apps/web/app/dashboard/curator/[profileId]/musicians/page.tsx):
// the curator-context browse of approved musician acts. type=="musician" &&
// status=="approved" is two pure-equality filters with no orderBy — provable
// under firestore.rules' profiles read rule (which only ever inspects
// `status`) via Firestore's automatic per-field indexing, no composite index
// needed (mirrors the SSR public pages' single-equality approved-profile
// reads, widened by one more equality clause).
export function MusicianBrowse({ curatorProfileId }: { curatorProfileId: string }) {
  const [musicians, setMusicians] = useState<MusicianRow[] | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [genre, setGenre] = useState<string | null>(null);
  const [actSize, setActSize] = useState<MusicianSubtype | null>(null);

  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    getDocs(query(collection(db, "profiles"), where("type", "==", "musician"), where("status", "==", "approved")))
      .then((snap) => {
        if (cancelled) return;
        setMusicians(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ProfileDoc) })));
      })
      .catch((e) => {
        if (cancelled) return;
        setMusicians([]);
        setError(e instanceof Error ? e.message : "Could not load musicians.");
      });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (musicians === "loading") return [];
    return musicians.filter((m) =>
      (genre === null || (m.portfolio?.genres ?? []).includes(genre))
      && (actSize === null || m.subtype === actSize));
  }, [musicians, genre, actSize]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setGenre(null)} style={chip(genre === null)}>All genres</button>
        {GENRES.map((g) => (
          <button key={g} type="button" onClick={() => setGenre(genre === g ? null : g)} style={chip(genre === g)}>{g}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" onClick={() => setActSize(null)} style={chip(actSize === null)}>Any act size</button>
        {ACT_SIZE_OPTIONS.map((a) => (
          <button key={a} type="button" onClick={() => setActSize(actSize === a ? null : a)} style={chip(actSize === a)}>
            {ACT_SIZE_LABEL[a]}
          </button>
        ))}
      </div>
      {error && (
        <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
          Could not load musicians: {error}
        </p>
      )}
      {musicians === "loading" && <p>Loading…</p>}
      {musicians !== "loading" && filtered.length === 0 && !error && <p style={{ color: "#666" }}>No approved musicians match these filters.</p>}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
        {filtered.map((m) => <MusicianCard key={m.id} curatorProfileId={curatorProfileId} musician={m} />)}
      </ul>
    </div>
  );
}
