"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { collectionGroup, doc, getDoc, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../../src/lib/firebase";
import { useAuth } from "../../../src/auth/AuthProvider";
import { formatGigDateTime, formatCents, BUDGET_STRUCTURE_LABEL, badge } from "../../../src/gigs/GigForms";
import {
  DEPOSIT_HONESTY_LINE, OfferFields, buildOfferPayload, emptyOffer, formatDuration, gigLocationLabel,
  type OfferState,
} from "../../../src/bookings/BookingForms";
import type { GigDoc, GigSeriesDoc, ProfileDoc, FillMode } from "@gatekeep/shared";

type MusicianOption = { profileId: string; name: string };

// Reveals fillMode only when the viewer can actually read the gigSeries doc
// (member of the curator profile, or admin) — gigSeries has no public
// disjunct in firestore.rules, so a permission-denied here is the EXPECTED,
// common case on this public page (not a failure): fall back to "hidden"
// (no fill-mode detail shown) rather than surfacing an error. Mirrors this
// task's controller-sanctioned resolution for GigBrowse's softer badge copy
// — this is the ONE surface allowed to attempt the fetch, per-gig, once.
// "loading" and "hidden" render identically (see the caller below), so there's
// no need to track them as separate states — the return expression collapses
// a null/absent seriesId straight to "hidden" without any effect-driven reset.
function useSeriesFillMode(seriesId: string | null): FillMode | "hidden" {
  const [state, setState] = useState<FillMode | "hidden">("hidden");
  useEffect(() => {
    if (!seriesId) return;
    let cancelled = false;
    const { db } = getFirebase();
    getDoc(doc(db, "gigSeries", seriesId))
      .then((s) => { if (!cancelled) setState(s.exists() ? (s.data() as GigSeriesDoc).fillMode : "hidden"); })
      .catch(() => { if (!cancelled) setState("hidden"); });
    return () => { cancelled = true; };
  }, [seriesId]);
  return seriesId ? state : "hidden";
}

function ApplyPanel({ gigId, gig, uid }: { gigId: string; gig: GigDoc; uid: string }) {
  const [musicianProfiles, setMusicianProfiles] = useState<MusicianOption[] | "loading">("loading");
  const [selectedOverride, setSelectedOverride] = useState<string | null>(null);
  const [offer, setOffer] = useState<OfferState>(emptyOffer());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyApplied, setAlreadyApplied] = useState(false);
  const [applied, setApplied] = useState(false);

  // "My approved musician profiles" — collectionGroup(members) filtered to
  // this uid, then a profile lookup per hit, mirroring app/dashboard/page.tsx's
  // ProfilesList exactly (see that file's comment for the rules-provability
  // rationale of the collection-group query itself).
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const unsub = onSnapshot(query(collectionGroup(db, "members"), where("uid", "==", uid)), async (snap) => {
      const out: MusicianOption[] = [];
      for (const m of snap.docs) {
        if (cancelled) return;
        const p = await getDoc(doc(db, "profiles", m.ref.parent.parent!.id));
        if (cancelled) return;
        if (p.exists()) {
          const d = p.data() as ProfileDoc;
          if (d.type === "musician" && d.status === "approved") out.push({ profileId: p.id, name: d.name });
        }
      }
      if (!cancelled) setMusicianProfiles(out);
    });
    return () => { cancelled = true; unsub(); };
  }, [uid]);

  // Derived, not effect-reset: the default selection is a pure function of
  // the fetched list + whatever the musician has explicitly picked, so it's
  // computed at render time rather than via a setState-in-effect (which
  // eslint-config-next's React Compiler rules flag — see
  // app/dashboard/page.tsx's ProfilesList comment on the same tradeoff).
  const selected = selectedOverride && musicianProfiles !== "loading" && musicianProfiles.some((m) => m.profileId === selectedOverride)
    ? selectedOverride
    : (musicianProfiles !== "loading" && musicianProfiles.length > 0 ? musicianProfiles[0].profileId : "");

  if (musicianProfiles === "loading") return <p>Loading your musician profiles…</p>;
  if (musicianProfiles.length === 0) {
    return <p>You need an approved musician profile to apply. <Link href="/dashboard">Set one up</Link>.</p>;
  }

  const submit = async () => {
    setError(null);
    const { payload, error: buildError } = buildOfferPayload(gig.budget.structure, offer);
    if (buildError || !payload) { setError(buildError ?? "Invalid offer."); return; }
    setBusy(true);
    try {
      await httpsCallable<{ gigId: string; musicianProfileId: string; offer: typeof payload }, { bookingId: string }>(
        getFirebase().functions, "applyToGig")({ gigId, musicianProfileId: selected, offer: payload });
      setApplied(true);
    } catch (e) {
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
      if (code === "functions/already-exists") setAlreadyApplied(true);
      else setError(e instanceof Error ? e.message : "Could not submit your application.");
    } finally {
      setBusy(false);
    }
  };

  if (applied) return <p style={{ color: "#16a34a" }}>Application sent! The curator has been notified.</p>;
  if (alreadyApplied) {
    return <p style={{ color: "#666" }}>You already have an open application for this gig with the selected profile.</p>;
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <label>Applying as:{" "}
        <select value={selected} onChange={(e) => setSelectedOverride(e.target.value)}>
          {musicianProfiles.map((m) => <option key={m.profileId} value={m.profileId}>{m.name}</option>)}
        </select>
      </label>
      <OfferFields structure={gig.budget.structure} value={offer} onChange={setOffer} disabled={busy} />
      {error && (
        <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
          {error}
        </p>
      )}
      <button onClick={submit} disabled={busy}>{busy ? "Applying…" : "Apply"}</button>
      <p style={{ color: "#666", fontSize: 13, margin: 0 }}>{DEPOSIT_HONESTY_LINE}</p>
    </div>
  );
}

export default function GigDetail(props: { params: Promise<{ gigId: string }> }) {
  const { gigId } = use(props.params);
  const { user } = useAuth();
  const [gig, setGig] = useState<GigDoc | null | "loading" | "unavailable">("loading");
  const [curatorName, setCuratorName] = useState<string | null>(null);
  const fillMode = useSeriesFillMode(gig !== "loading" && gig !== "unavailable" && gig ? gig.seriesId : null);

  // No synchronous setGig("loading") reset at the top — gigId is fixed for
  // this route's whole lifetime under this app's plain-<a>/full-navigation
  // convention (see the Link/`<a>` split below), so the initial useState
  // value already covers the loading state; every actual state transition
  // happens inside onSnapshot's own success/error callbacks.
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const unsub = onSnapshot(doc(db, "gigs", gigId),
      (s) => { if (!cancelled) setGig(s.exists() ? (s.data() as GigDoc) : "unavailable"); },
      (e) => {
        if (cancelled) return;
        // permission-denied is the common, legitimate case here (a gig
        // that's draft/cancelled/taken_down/closed-unbooked isn't publicly
        // readable — see firestore.rules' gigs read rule). Anything else
        // (offline, a real backend fault) still renders the same friendly
        // state — a client page has no 500 to fall back to — but gets
        // logged so it's not silently indistinguishable from "not open".
        const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
        if (code !== "permission-denied" && code !== "not-found") console.error("gig load failed", gigId, e);
        setGig("unavailable");
      });
    return () => { cancelled = true; unsub(); };
  }, [gigId]);

  useEffect(() => {
    if (gig === "loading" || gig === "unavailable" || !gig) return;
    let cancelled = false;
    getDoc(doc(getFirebase().db, "profiles", gig.curatorProfileId))
      .then((s) => { if (!cancelled) setCuratorName(s.exists() ? (s.data() as ProfileDoc).name : null); })
      .catch(() => { if (!cancelled) setCuratorName(null); });
    return () => { cancelled = true; };
  }, [gig]);

  if (gig === "loading") return <main style={{ maxWidth: 640, margin: "40px auto" }}><p>Loading…</p></main>;
  if (gig === "unavailable" || !gig) {
    return (
      <main style={{ maxWidth: 640, margin: "40px auto", display: "grid", gap: 16 }}>
        <Link href="/gigs" style={{ color: "#666", fontSize: 14 }}>← Find gigs</Link>
        <p>This gig isn&apos;t available anymore.</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", display: "grid", gap: 20 }}>
      <Link href="/gigs" style={{ color: "#666", fontSize: 14 }}>← Find gigs</Link>
      <h1>{gig.title || "Untitled gig"}</h1>
      {curatorName && <p style={{ color: "#666", margin: 0 }}>Posted by {curatorName}</p>}
      <p style={{ margin: 0 }}>{formatGigDateTime(gig.startsAt)} · {formatDuration(gig.durationMinutes)}</p>
      <p style={{ margin: 0 }}>
        {formatCents(gig.budget.minCents)}–{formatCents(gig.budget.maxCents)} {BUDGET_STRUCTURE_LABEL[gig.budget.structure]}
      </p>
      {gig.description && <p style={{ whiteSpace: "pre-wrap" }}>{gig.description}</p>}
      {(gig.wants.genres.length > 0 || gig.wants.actSizes.length > 0) && (
        <p style={{ margin: 0 }}>
          Looking for: {[gig.wants.genres.join(", "), gig.wants.actSizes.join(", ")].filter(Boolean).join(" · ")}
        </p>
      )}
      <p style={{ margin: 0 }}>{gigLocationLabel(gig.location)}</p>
      {(gig.provisions.hasPA != null || gig.provisions.hasBackline != null || gig.provisions.notes) && (
        <p style={{ margin: 0, color: "#666" }}>
          {[
            gig.provisions.hasPA != null ? `PA: ${gig.provisions.hasPA ? "provided" : "not provided"}` : null,
            gig.provisions.hasBackline != null ? `Backline: ${gig.provisions.hasBackline ? "provided" : "not provided"}` : null,
            gig.provisions.notes,
          ].filter(Boolean).join(" · ")}
        </p>
      )}
      {gig.seriesId != null && (
        <span style={{ ...badge("#e0e7ff"), width: "fit-content" }}>
          {fillMode === "whole_run" ? "Books as a run — one act plays every date"
            : fillMode === "per_occurrence" ? "Part of a recurring series — each date booked separately"
            : "Part of a recurring series"}
        </span>
      )}
      {gig.status !== "open" ? (
        <p style={{ color: "#666" }}>This gig is no longer accepting applications.</p>
      ) : !user ? (
        <p><Link href="/sign-in">Sign in</Link> to apply for this gig.</p>
      ) : (
        <section style={{ borderTop: "1px solid #eee", paddingTop: 16, display: "grid", gap: 12 }}>
          <h2>Apply for this gig</h2>
          {/* Keyed by uid: resets every Apply-panel field the instant the
              signed-in identity changes, mirroring app/dashboard/page.tsx's
              ProfilesList/NotificationsList key={user.uid} pattern — without
              it, a sign-out/sign-in on this same page would leave the
              PREVIOUS user's musician-profile picker and in-progress offer
              showing under the new identity until a full reload. */}
          <ApplyPanel key={user.uid} gigId={gigId} gig={gig} uid={user.uid} />
        </section>
      )}
    </main>
  );
}
