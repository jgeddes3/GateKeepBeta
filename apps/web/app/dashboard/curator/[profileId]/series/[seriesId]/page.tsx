"use client";
import { use, useEffect, useState } from "react";
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
import {
  validateGigContent, validateBudget, validateRecurrence,
  type ProfileDoc, type CuratorSubtype, type GigDoc, type GigSeriesDoc, type GigContentInput, type GigBudget,
} from "@gatekeep/shared";

type OccurrenceRow = GigDoc & { id: string };

// The template editor — keyed by seriesId by the parent, so it seeds its
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
    // Same omit-when-unchanged rule as GigEditForm — updateSeries treats an
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
    <section style={{ display: "grid", gap: 12 }}>
      <p style={{ color: "#666", margin: 0 }}>
        Saving applies to future, unedited dates only — occurrences you&apos;ve edited directly (in the gig editor)
        have detached from this template and won&apos;t change.
      </p>
      <ContentFields value={content} onChange={setContent} />
      <BudgetFields value={budget} onChange={setBudget} />
      <RecurrenceFields value={recurrence} onChange={setRecurrence} />
      <ProvisionsFields value={provisions} onChange={setProvisions} />
      <LocationFields isVenue={isVenue} addressRequired={false} currentLabel={currentLabel} value={location} onChange={setLocation} />
      {/* P10: a visibility change here only reaches future, still-attached
          occurrences (same propagation rule as every other template field,
          explained above) — a curator changing this needs to know an
          individually-edited occurrence's own address visibility won't move
          with it. */}
      <p style={{ color: "#666", fontSize: 12, margin: 0 }}>
        Occurrences you&apos;ve edited individually keep their current address visibility.
      </p>
      {error && (
        <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
          {error}
        </p>
      )}
      <button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save template"}</button>
    </section>
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
  // the two ever disagree — depending on the primitive string, not the whole
  // `series` object, avoids resubscribing on every template save (the series
  // doc's identity changes on every snapshot; curatorProfileId itself never
  // does). where(curatorProfileId)+where(seriesId) is two plain equality
  // filters — no composite index needed (see firestore.indexes.json), and
  // pinning curatorProfileId is what makes this list rules-provable at all:
  // gigs' read rule has no seriesId-based disjunct, only status=='open' or
  // isMember(curatorProfileId) — a seriesId-only filter wouldn't prove
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

  if (loading || !user || profile === "loading" || series === "loading") return <main><p>Loading…</p></main>;
  if (!profile || !series) return <main><p>Series not found.</p></main>;

  const subtype = profile.subtype as CuratorSubtype;
  const isVenue = subtype === "venue";
  const cadenceSummary =
    `${WEEKDAY_LABELS[series.recurrence.weekday]}s, ` +
    `${String(series.recurrence.hour).padStart(2, "0")}:${String(series.recurrence.minute).padStart(2, "0")}, ${series.recurrence.cadence}`;

  const pause = async () => {
    if (!window.confirm("Pause this series? No new dates will be created going forward — already-open dates stay open. This can't be undone.")) return;
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
    <main style={{ maxWidth: 640, margin: "40px auto", display: "grid", gap: 24 }}>
      <a href={`/dashboard/curator/${profileId}/gigs`} style={{ color: "#666", fontSize: 14 }}>← Gigs & series</a>
      <h1>{series.template.title || "Untitled series"}</h1>
      <p style={{ margin: 0 }}>
        Status: <strong>{SERIES_STATUS_LABEL[series.status]}</strong> · {cadenceSummary}
      </p>
      {series.status === "ended"
        ? <p style={{ color: "#666" }}>This series has ended and can no longer be edited.</p>
        : <SeriesTemplateForm key={seriesId} seriesId={seriesId} series={series} isVenue={isVenue} />}
      <section style={{ display: "flex", gap: 8, borderTop: "1px solid #eee", paddingTop: 16 }}>
        {series.status === "active" && (
          <button onClick={pause} disabled={pauseBusy}
            style={{ color: "#92400e", background: "none", border: "1px solid #fde68a", borderRadius: 6, padding: "6px 12px" }}>
            {pauseBusy ? "Pausing…" : "Pause series"}
          </button>
        )}
        {series.status !== "ended" && (
          <button onClick={end} disabled={endBusy}
            style={{ color: "#dc2626", background: "none", border: "1px solid #fca5a5", borderRadius: 6, padding: "6px 12px" }}>
            {endBusy ? "Ending…" : "End series"}
          </button>
        )}
      </section>
      <section style={{ display: "grid", gap: 8 }}>
        <h2>Occurrences</h2>
        {occurrences.length === 0 && (
          <p style={{ color: "#666" }}>
            No dates yet — the daily sweep materializes upcoming occurrences from this template automatically.
          </p>
        )}
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {occurrences.map((occ) => (
            <li key={occ.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 10 }}>
              <a href={`/dashboard/curator/${profileId}/gigs/${occ.id}`}><strong>{formatGigDateTime(occ.startsAt)}</strong></a>
              {" · "}{GIG_STATUS_LABEL[occ.status]}
              {occ.detachedFromTemplate && " · detached"}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
