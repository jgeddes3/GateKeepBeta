"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { doc, onSnapshot, collection, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../../../../../src/lib/firebase";
import { useAuth } from "../../../../../../src/auth/AuthProvider";
import {
  ContentFields, BudgetFields, ProvisionsFields, LocationFields, RecurrenceFields,
  contentFrom, provisionsFrom, budgetFrom, recurrenceFrom, endDateInputToUtcMs, MAX_ADDRESS_LENGTH,
  GIG_STATUS_LABEL, SERIES_STATUS_LABEL, WEEKDAY_LABELS, formatGigDateTime,
  type ContentState, type ProvisionsState, type BudgetState, type RecurrenceState, type LocationValue,
  type UpdateSeriesPayload,
} from "../../../../../../src/gigs/GigForms";
import { formatChipLabel } from "../../../../../../src/portfolio/PortfolioForms";
import {
  validateGigContent, validateBudget, validateRecurrence,
  type ProfileDoc, type CuratorSubtype, type GigDoc, type GigSeriesDoc, type GigContentInput, type GigBudget,
  type SeriesStatus,
} from "@gatekeep/shared";
import { Button } from "../../../../../../src/ui/button";
import { Badge } from "../../../../../../src/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../../../src/ui/card";
import { Skeleton } from "../../../../../../src/ui/skeleton";
import { IconWarning } from "../../../../../../src/ui/icons";

type OccurrenceRow = GigDoc & { id: string };
type BadgeVariant = "secondary" | "outline" | "success" | "warning" | "destructive";
const GIG_STATUS_BADGE: Record<GigDoc["status"], BadgeVariant> = {
  draft: "secondary", open: "success", filled: "outline", closed: "secondary", cancelled: "destructive", taken_down: "warning",
};
const SERIES_STATUS_BADGE: Record<SeriesStatus, BadgeVariant> = { active: "success", paused: "warning", ended: "secondary" };

// The template editor: keyed by seriesId by the parent, so it seeds its
// local state once from the first snapshot (same "seed once, never reseed"
// contract as GigEditForm / CuratorForms.tsx's forms).
function SeriesTemplateForm({ seriesId, series, isVenue }: { seriesId: string; series: GigSeriesDoc; isVenue: boolean }) {
  const [content, setContent] = useState<ContentState>(contentFrom(series.template));
  const [budget, setBudget] = useState<BudgetState>(budgetFrom(series.template.budget));
  const [provisions, setProvisions] = useState<ProvisionsState>(provisionsFrom(series.template.provisions));
  const [location, setLocation] = useState<LocationValue>({ address: "", visibility: series.template.location.addressVisibility });
  const [recurrence, setRecurrence] = useState<RecurrenceState>(recurrenceFrom(series.recurrence, series.fillMode));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentLabel = `Currently on file: ${series.templatePrivateLocation.address} ` +
    `(${series.template.location.addressVisibility === "public" ? "shown publicly" : "neighborhood only, publicly"})`;

  const save = async () => {
    setError(null);
    const wants = { genres: content.genres, actSizes: content.actSizes };
    const durationMinutes = Number(content.duration);
    const contentInput: GigContentInput = {
      title: content.title, description: content.description, wants, durationMinutes,
      provisions: { hasPA: provisions.hasPA, hasBackline: provisions.hasBackline, notes: provisions.notes.trim() || null },
    };
    const cv = validateGigContent(contentInput);
    if (!cv.ok) { setError(cv.reason); return; }

    const minDollars = Number(budget.min); const maxDollars = Number(budget.max);
    if (budget.min.trim() === "" || budget.max.trim() === "" || !Number.isFinite(minDollars) || !Number.isFinite(maxDollars)) {
      setError("Enter a minimum and maximum budget.");
      return;
    }
    const budgetInput: GigBudget = { minCents: Math.round(minDollars * 100), maxCents: Math.round(maxDollars * 100), structure: budget.structure };
    const bv = validateBudget(budgetInput);
    if (!bv.ok) { setError(bv.reason); return; }

    const [hourStr, minuteStr] = recurrence.time.split(":");
    const recurrenceInput = {
      weekday: recurrence.weekday, hour: Number(hourStr), minute: Number(minuteStr),
      cadence: recurrence.cadence, endDate: endDateInputToUtcMs(recurrence.endDate),
    };
    const rv = validateRecurrence(recurrenceInput, Date.now());
    if (!rv.ok) { setError(rv.reason); return; }

    const trimmedAddress = location.address.trim();
    if (trimmedAddress.length > MAX_ADDRESS_LENGTH) { setError(`Address must be at most ${MAX_ADDRESS_LENGTH} characters.`); return; }
    // Same omit-when-unchanged rule as GigEditForm: updateSeries treats an
    // omitted location as "leave the template's location untouched," which
    // also means the propagation loop below it skips the extra
    // private/location subdoc rewrite on every future occurrence.
    const locationChanged = trimmedAddress.length > 0 || location.visibility !== series.template.location.addressVisibility;

    setBusy(true);
    try {
      const payload: UpdateSeriesPayload = locationChanged
        ? { seriesId, ...contentInput, budget: budgetInput, recurrence: recurrenceInput, fillMode: recurrence.fillMode,
            location: { address: trimmedAddress || null, addressVisibility: location.visibility } }
        : { seriesId, ...contentInput, budget: budgetInput, recurrence: recurrenceInput, fillMode: recurrence.fillMode };
      await httpsCallable(getFirebase().functions, "updateSeries")(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the template.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6">
      <p className="font-sora text-sm text-gk-muted">
        Saving applies to future, unedited dates only. Occurrences you&apos;ve edited directly (in the gig editor)
        have detached from this template and won&apos;t change.
      </p>
      <Card>
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardContent><ContentFields value={content} onChange={setContent} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Budget</CardTitle></CardHeader>
        <CardContent><BudgetFields value={budget} onChange={setBudget} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Schedule</CardTitle></CardHeader>
        <CardContent><RecurrenceFields value={recurrence} onChange={setRecurrence} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Provisions</CardTitle></CardHeader>
        <CardContent><ProvisionsFields value={provisions} onChange={setProvisions} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Location</CardTitle></CardHeader>
        <CardContent>
          <LocationFields isVenue={isVenue} addressRequired={false} currentLabel={currentLabel} value={location} onChange={setLocation} />
          {/* P10: a visibility change here only reaches future, still-attached
              occurrences (same propagation rule as every other template field,
              explained above), a curator changing this needs to know an
              individually-edited occurrence's own address visibility won't move
              with it. */}
          <p className="mt-3 font-sora text-xs text-gk-muted">
            Occurrences you&apos;ve edited individually keep their current address visibility.
          </p>
        </CardContent>
      </Card>
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
        >
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p>{error}</p>
        </div>
      )}
      <Button type="button" onClick={save} disabled={busy} className="justify-self-start">
        {busy ? "Saving…" : "Save template"}
      </Button>
    </div>
  );
}

export default function SeriesDetail(props: { params: Promise<{ profileId: string; seriesId: string }> }) {
  const { profileId, seriesId } = use(props.params);
  const { user, loading } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileDoc | null | "loading">("loading");
  const [series, setSeries] = useState<GigSeriesDoc | null | "loading">("loading");
  const [occurrences, setOccurrences] = useState<OccurrenceRow[]>([]);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [endBusy, setEndBusy] = useState(false);

  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", profileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null),
      () => setProfile(null));
  }, [user, profileId]);
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "gigSeries", seriesId),
      (s) => setSeries(s.exists() ? (s.data() as GigSeriesDoc) : null),
      () => setSeries(null));
  }, [user, seriesId]);
  // Keyed off the series' OWN curatorProfileId (not the route's profileId
  // segment) so this query is always tied to the doc's actual owner even if
  // the two ever disagree: depending on the primitive string, not the whole
  // `series` object, avoids resubscribing on every template save (the series
  // doc's identity changes on every snapshot; curatorProfileId itself never
  // does). where(curatorProfileId)+where(seriesId) is two plain equality
  // filters, no composite index needed (see firestore.indexes.json), and
  // pinning curatorProfileId is what makes this list rules-provable at all:
  // gigs' read rule has no seriesId-based disjunct, only status=='open' or
  // isMember(curatorProfileId): a seriesId-only filter wouldn't prove
  // membership for the whole result set. Sorted client-side by startsAt: no
  // (curatorProfileId,seriesId,startsAt) composite exists, only
  // (seriesId,startsAt) and (curatorProfileId,status).
  const curatorProfileId = series && series !== "loading" ? series.curatorProfileId : null;
  useEffect(() => {
    if (!user || !curatorProfileId) return;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "gigs"), where("curatorProfileId", "==", curatorProfileId), where("seriesId", "==", seriesId)),
      (s) => setOccurrences(s.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) })).sort((a, b) => a.startsAt - b.startsAt)));
  }, [user, curatorProfileId, seriesId]);

  if (loading || !user || profile === "loading" || series === "loading") {
    return (
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14" role="status" aria-label="Loading">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-4 h-9 w-56" />
        <div className="mt-8 grid gap-6">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      </main>
    );
  }
  if (!profile || !series) {
    return (
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16 text-center sm:px-6">
        <p className="font-syne text-lg font-semibold text-gk-text">Series not found</p>
        <Button asChild className="mt-4"><Link href={`/dashboard/curator/${profileId}/gigs`}>Back to gigs</Link></Button>
      </main>
    );
  }

  const subtype = profile.subtype as CuratorSubtype;
  const isVenue = subtype === "venue";
  const cadenceSummary =
    `${WEEKDAY_LABELS[series.recurrence.weekday]}s, ` +
    `${String(series.recurrence.hour).padStart(2, "0")}:${String(series.recurrence.minute).padStart(2, "0")}, ${formatChipLabel(series.recurrence.cadence)}`;

  const pause = async () => {
    if (!window.confirm("Pause this series? No new dates will be created going forward. Already-open dates stay open. This can't be undone.")) return;
    setPauseBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "pauseSeries")({ seriesId });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not pause this series.");
    } finally {
      setPauseBusy(false);
    }
  };
  const end = async () => {
    if (!window.confirm("End this series? Future open or draft dates will be cancelled and no new dates will be created. This can't be undone.")) return;
    setEndBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "endSeries")({ seriesId });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not end this series.");
    } finally {
      setEndBusy(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <Link href={`/dashboard/curator/${profileId}/gigs`} className="font-sora text-sm text-gk-muted hover:text-gk-text">
        &larr; Gigs &amp; series
      </Link>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">{series.template.title || "Untitled series"}</h1>
        <Badge variant={SERIES_STATUS_BADGE[series.status]}>{SERIES_STATUS_LABEL[series.status]}</Badge>
      </div>
      <p className="mt-1 font-sora text-sm text-gk-muted">{cadenceSummary}</p>

      <div className="mt-6">
        {series.status === "ended"
          ? <p className="font-sora text-sm text-gk-muted">This series has ended and can no longer be edited.</p>
          : <SeriesTemplateForm key={seriesId} seriesId={seriesId} series={series} isVenue={isVenue} />}
      </div>

      <section className="mt-8 flex flex-wrap gap-3 border-t border-gk-border pt-8">
        {series.status === "active" && (
          <Button type="button" variant="secondary" onClick={pause} disabled={pauseBusy}>
            {pauseBusy ? "Pausing…" : "Pause series"}
          </Button>
        )}
        {series.status !== "ended" && (
          <Button type="button" variant="destructive" onClick={end} disabled={endBusy}>
            {endBusy ? "Ending…" : "End series"}
          </Button>
        )}
      </section>

      <section className="mt-8 grid gap-3">
        <h2 className="font-syne text-lg font-semibold text-gk-text">Occurrences</h2>
        {occurrences.length === 0 ? (
          <p className="font-sora text-sm text-gk-muted">
            No dates yet. The daily sweep materializes upcoming occurrences from this template automatically.
          </p>
        ) : (
          <ul className="grid gap-2">
            {occurrences.map((occ) => (
              <li key={occ.id} className="flex flex-wrap items-center gap-2 rounded-gk border border-gk-border bg-gk-surface px-4 py-3">
                <Link href={`/dashboard/curator/${profileId}/gigs/${occ.id}`} className="font-syne text-sm font-semibold text-gk-text hover:text-gk-accent">
                  {formatGigDateTime(occ.startsAt)}
                </Link>
                <Badge variant={GIG_STATUS_BADGE[occ.status]}>{GIG_STATUS_LABEL[occ.status]}</Badge>
                {occ.detachedFromTemplate && <Badge variant="secondary">Detached</Badge>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
