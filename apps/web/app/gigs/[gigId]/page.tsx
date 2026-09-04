"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { collectionGroup, doc, getDoc, onSnapshot, query, where } from "firebase/firestore";
import { getFirebase } from "../../../src/lib/firebase";
import { callFn } from "../../../src/lib/callable";
import { useAuth } from "../../../src/auth/AuthProvider";
import { formatGigDateTime, formatCents, BUDGET_STRUCTURE_LABEL } from "../../../src/gigs/GigForms";
import { formatChipLabel } from "../../../src/portfolio/PortfolioForms";
import {
  DEPOSIT_HONESTY_LINE, OfferFields, buildOfferPayload, emptyOffer, formatDuration, gigLocationLabel,
  type OfferState,
} from "../../../src/bookings/BookingForms";
import { GatePrompt } from "../../../src/payments/GatePrompt";
import type { GigDoc, GigSeriesDoc, ProfileDoc, FillMode } from "@gatekeep/shared";
import { Button } from "../../../src/ui/button";
import { Badge } from "../../../src/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../src/ui/select";
import { Skeleton } from "../../../src/ui/skeleton";
import { IconWarning } from "../../../src/ui/icons";

type MusicianOption = { profileId: string; name: string };

// Reveals fillMode only when the viewer can actually read the gigSeries doc
// (member of the curator profile, or admin): gigSeries has no public
// disjunct in firestore.rules, so a permission-denied here is the EXPECTED,
// common case on this public page (not a failure): fall back to "hidden"
// (no fill-mode detail shown) rather than surfacing an error. Mirrors this
// task's controller-sanctioned resolution for GigBrowse's softer badge copy:
// this is the ONE surface allowed to attempt the fetch, per-gig, once.
// "loading" and "hidden" render identically (see the caller below), so there's
// no need to track them as separate states: the return expression collapses
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

  // "My approved musician profiles": collectionGroup(members) filtered to
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
  // eslint-config-next's React Compiler rules flag, see
  // app/dashboard/page.tsx's ProfilesList comment on the same tradeoff).
  const selected = selectedOverride && musicianProfiles !== "loading" && musicianProfiles.some((m) => m.profileId === selectedOverride)
    ? selectedOverride
    : (musicianProfiles !== "loading" && musicianProfiles.length > 0 ? musicianProfiles[0].profileId : "");

  if (musicianProfiles === "loading") return <p className="font-sora text-sm text-gk-muted">Loading your musician profiles…</p>;
  if (musicianProfiles.length === 0) {
    return (
      <p className="font-sora text-sm text-gk-muted">
        You need an approved musician profile to apply.{" "}
        <Link href="/dashboard" className="text-gk-text underline underline-offset-4 hover:text-gk-focus">Set one up</Link>.
      </p>
    );
  }

  const submit = async () => {
    setError(null);
    const { payload, error: buildError } = buildOfferPayload(gig.budget.structure, offer);
    if (buildError || !payload) { setError(buildError ?? "Invalid offer."); return; }
    setBusy(true);
    try {
      await callFn<{ gigId: string; musicianProfileId: string; offer: typeof payload }, { bookingId: string }>("applyToGig", { gigId, musicianProfileId: selected, offer: payload });
      setApplied(true);
    } catch (e) {
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
      if (code === "functions/already-exists") setAlreadyApplied(true);
      else setError(e instanceof Error ? e.message : "Could not submit your application.");
    } finally {
      setBusy(false);
    }
  };

  if (applied) {
    return <p className="font-sora text-sm text-gk-success">Application sent! The curator has been notified.</p>;
  }
  if (alreadyApplied) {
    return (
      <p className="font-sora text-sm text-gk-muted">There&apos;s already an open booking between this act and this gig.</p>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="grid max-w-xs gap-1.5">
        <label htmlFor="apply-as" className="font-sora text-sm font-medium text-gk-text">Applying as</label>
        <Select value={selected} onValueChange={setSelectedOverride}>
          <SelectTrigger id="apply-as" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {musicianProfiles.map((m) => <SelectItem key={m.profileId} value={m.profileId}>{m.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {/* OfferFields' own internals are a booking surface out of scope for
          this task (unrestyled, see BookingForms.tsx): only its container
          spacing here changed. */}
      <OfferFields structure={gig.budget.structure} value={offer} onChange={setOffer} disabled={busy} />
      {/* SP5 Task 15: applyToGig's own gate (requireMusicianPayoutReady)
          throws MUSICIAN_PAYOUTS_REQUIRED_MESSAGE verbatim: GatePrompt
          links to /dashboard/earnings; any other error falls through to the
          same plain warning line this used to render directly. */}
      {error && <GatePrompt message={error} viewerIsMusician onRetry={submit} />}
      <Button type="button" onClick={submit} disabled={busy} className="justify-self-start">
        {busy ? "Applying…" : "Apply"}
      </Button>
      <p className="font-sora text-xs text-gk-muted">{DEPOSIT_HONESTY_LINE}</p>
    </div>
  );
}

function GigDetailSkeleton() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14" role="status" aria-label="Loading gig">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-9 w-2/3" />
      <div className="mt-6 grid gap-2">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/5" />
      </div>
    </main>
  );
}

export default function GigDetail(props: { params: Promise<{ gigId: string }> }) {
  const { gigId } = use(props.params);
  const { user } = useAuth();
  const [gig, setGig] = useState<GigDoc | null | "loading" | "unavailable">("loading");
  const [curatorName, setCuratorName] = useState<string | null>(null);
  const fillMode = useSeriesFillMode(gig !== "loading" && gig !== "unavailable" && gig ? gig.seriesId : null);
  const curatorProfileId = gig !== "loading" && gig !== "unavailable" && gig ? gig.curatorProfileId : null;

  // No synchronous setGig("loading") reset at the top: gigId is fixed for
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
        // readable, see firestore.rules' gigs read rule). Anything else
        // (offline, a real backend fault) still renders the same friendly
        // state (a client page has no 500 to fall back to), but gets
        // logged so it's not silently indistinguishable from "not open".
        const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
        if (code !== "permission-denied" && code !== "not-found") console.error("gig load failed", gigId, e);
        setGig("unavailable");
      });
    return () => { cancelled = true; unsub(); };
  }, [gigId]);

  // Depends on curatorProfileId alone (not the whole `gig` object): `gig`
  // gets a new reference on every onSnapshot update (e.g. status flipping
  // open -> filled), which would otherwise re-run this fetch on every such
  // update even though the curator never changes for a given gig.
  useEffect(() => {
    if (!curatorProfileId) return;
    let cancelled = false;
    getDoc(doc(getFirebase().db, "profiles", curatorProfileId))
      .then((s) => { if (!cancelled) setCuratorName(s.exists() ? (s.data() as ProfileDoc).name : null); })
      .catch(() => { if (!cancelled) setCuratorName(null); });
    return () => { cancelled = true; };
  }, [curatorProfileId]);

  if (gig === "loading") return <GigDetailSkeleton />;
  if (gig === "unavailable" || !gig) {
    return (
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-16 text-center sm:px-6">
        <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
          <IconWarning size={20} aria-hidden="true" />
        </span>
        <p className="mt-3 font-syne text-lg font-semibold text-gk-text">This gig isn&apos;t available anymore</p>
        <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
          It may have been filled, closed, or taken down since you found it.
        </p>
        <Button asChild className="mt-4">
          <Link href="/gigs">Find other gigs</Link>
        </Button>
      </main>
    );
  }

  const lookingForLine = [gig.wants.genres.map(formatChipLabel).join(", "), gig.wants.actSizes.map(formatChipLabel).join(", ")]
    .filter(Boolean).join(" · ");
  const provisionsLine = [
    gig.provisions.hasPA != null ? `PA: ${gig.provisions.hasPA ? "provided" : "not provided"}` : null,
    gig.provisions.hasBackline != null ? `Backline: ${gig.provisions.hasBackline ? "provided" : "not provided"}` : null,
    gig.provisions.notes,
  ].filter(Boolean).join(" · ");
  const seriesLine = fillMode === "whole_run" ? "Books as a run: one act plays every date"
    : fillMode === "per_occurrence" ? "Part of a recurring series: each date booked separately"
    : "Part of a recurring series";

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <Link href="/gigs" className="font-sora text-sm text-gk-muted hover:text-gk-text">
        &larr; Find gigs
      </Link>
      <h1 className="mt-4 font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">{gig.title || "Untitled gig"}</h1>
      {curatorName && <p className="mt-1 font-sora text-sm text-gk-muted">Posted by {curatorName}</p>}

      <div className="mt-6 grid gap-1.5">
        <p className="font-sora text-sm text-gk-text">
          {formatGigDateTime(gig.startsAt)} · {formatDuration(gig.durationMinutes)}
        </p>
        {/* Filled pill, not bare ember text: same DESIGN.md accessibility
            note as GigCard's price (bare text-gk-accent on this page's
            gk-page/gk-surface fails AA in light theme; the prescribed
            fix is a filled chip/pill, ember fill + on-accent text,
            which Badge's "default" variant already is). */}
        <Badge variant="default" className="w-fit font-syne text-base font-semibold">
          {formatCents(gig.budget.minCents)}–{formatCents(gig.budget.maxCents)} {BUDGET_STRUCTURE_LABEL[gig.budget.structure]}
        </Badge>
        <p className="font-sora text-sm text-gk-muted">{gigLocationLabel(gig.location)}</p>
      </div>

      {gig.seriesId != null && (
        <Badge variant="outline" className="mt-4 w-fit">{seriesLine}</Badge>
      )}

      {gig.description && (
        <p className="mt-6 whitespace-pre-wrap font-sora text-sm text-gk-text">{gig.description}</p>
      )}

      {lookingForLine && (
        <div className="mt-6 grid gap-1.5">
          <span className="font-sora text-sm font-medium text-gk-text">Looking for</span>
          <p className="font-sora text-sm text-gk-muted">{lookingForLine}</p>
        </div>
      )}

      {provisionsLine && (
        <p className="mt-4 font-sora text-sm text-gk-muted">{provisionsLine}</p>
      )}

      {gig.status !== "open" ? (
        <p className="mt-8 border-t border-gk-border pt-6 font-sora text-sm text-gk-muted">
          This gig is no longer accepting applications.
        </p>
      ) : !user ? (
        <p className="mt-8 border-t border-gk-border pt-6 font-sora text-sm text-gk-muted">
          <Link href="/sign-in" className="text-gk-text underline underline-offset-4 hover:text-gk-focus">Sign in</Link>
          {" "}to apply for this gig.
        </p>
      ) : (
        <section className="mt-8 grid gap-3 border-t border-gk-border pt-8">
          <h2 className="font-syne text-lg font-semibold text-gk-text">Apply for this gig</h2>
          {/* Keyed by uid: resets every Apply-panel field the instant the
              signed-in identity changes, mirroring app/dashboard/page.tsx's
              ProfilesList/NotificationsList key={user.uid} pattern: without
              it, a sign-out/sign-in on this same page would leave the
              PREVIOUS user's musician-profile picker and in-progress offer
              showing under the new identity until a full reload. */}
          <ApplyPanel key={user.uid} gigId={gigId} gig={gig} uid={user.uid} />
        </section>
      )}
    </main>
  );
}
