"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../../../../../src/lib/firebase";
import { useAuth } from "../../../../../../src/auth/AuthProvider";
import {
  ContentFields, BudgetFields, ProvisionsFields, LocationFields, RecurrenceFields,
  emptyContent, emptyBudget, emptyProvisions, emptyRecurrence, endDateInputToUtcMs, MAX_ADDRESS_LENGTH,
  type LocationValue, type CreateGigPayload, type CreateSeriesPayload,
} from "../../../../../../src/gigs/GigForms";
import {
  validateGigContent, validateBudget, validateRecurrence,
  type ProfileDoc, type CuratorSubtype, type GigContentInput, type GigBudget, type AddressVisibility,
} from "@gatekeep/shared";

// The composer's one-off/series fork mirrors /join's musician/curator toggle
// exactly (same "click a chip, the form below reshapes" pattern) — a single
// page rather than two, since the shared fields (content/budget/provisions/
// location) are identical and only the "when" section differs (a single
// startsAt datetime vs. a weekday/hour/cadence recurrence + fillMode).
export default function NewGigOrSeries(props: { params: Promise<{ profileId: string }> }) {
  const { profileId } = use(props.params);
  const { user, loading } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileDoc | null | "loading">("loading");
  const [isSeries, setIsSeries] = useState(false);
  const [content, setContent] = useState(emptyContent());
  const [budget, setBudget] = useState(emptyBudget());
  const [provisions, setProvisions] = useState(emptyProvisions());
  const [location, setLocation] = useState<LocationValue>({ address: "", visibility: "public" });
  const [visibilityTouched, setVisibilityTouched] = useState(false);
  const [oneOffDate, setOneOffDate] = useState("");
  const [recurrence, setRecurrence] = useState(emptyRecurrence());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", profileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null),
      () => setProfile(null));
  }, [user, profileId]);

  if (loading || !user || profile === "loading") return <main><p>Loading…</p></main>;
  if (!profile || profile.type !== "curator") return <main><p>No curator profile here.</p></main>;
  if (profile.status !== "approved") {
    return <main style={{ maxWidth: 640, margin: "40px auto" }}>
      <p>Your curator profile must be approved before you can post gigs.</p>
      <a href={`/dashboard/curator/${profileId}`}>← Back to profile</a>
    </main>;
  }

  const subtype = profile.subtype as CuratorSubtype;
  const isVenue = subtype === "venue";
  // Same defaulting rule resolveGigLocation applies server-side
  // (isVenue ? "public" : "neighborhood") — computed at render time from the
  // subtype rather than seeded into state on mount, so it stays correct
  // even though `profile` arrives asynchronously; `visibilityTouched` tracks
  // whether the curator has actually picked a value yet.
  const defaultVisibility: AddressVisibility = isVenue ? "public" : "neighborhood";
  const effectiveLocation: LocationValue = visibilityTouched ? location : { ...location, visibility: defaultVisibility };
  const curatorAddress = profile.curator?.location?.address ?? null;
  const currentLabel = isVenue
    ? (curatorAddress ? `Your venue's address on file: ${curatorAddress}` : "No venue address on file yet.")
    : "Enter the address for this specific gig.";

  const submit = async () => {
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

    const trimmedAddress = effectiveLocation.address.trim();
    if (!isVenue && trimmedAddress.length === 0) { setError("An address is required for this gig."); return; }
    if (trimmedAddress.length > MAX_ADDRESS_LENGTH) { setError(`Address must be at most ${MAX_ADDRESS_LENGTH} characters.`); return; }
    const locationInput = { address: trimmedAddress || null, addressVisibility: effectiveLocation.visibility };

    setBusy(true);
    try {
      if (isSeries) {
        const [hourStr, minuteStr] = recurrence.time.split(":");
        const recurrenceInput = {
          weekday: recurrence.weekday, hour: Number(hourStr), minute: Number(minuteStr),
          cadence: recurrence.cadence, endDate: endDateInputToUtcMs(recurrence.endDate),
        };
        const rv = validateRecurrence(recurrenceInput, Date.now());
        if (!rv.ok) { setError(rv.reason); setBusy(false); return; }
        const payload: CreateSeriesPayload = {
          profileId, ...contentInput, budget: budgetInput,
          recurrence: recurrenceInput, fillMode: recurrence.fillMode, location: locationInput,
        };
        const { data } = await httpsCallable<CreateSeriesPayload, { seriesId: string }>(
          getFirebase().functions, "createSeries")(payload);
        router.push(`/dashboard/curator/${profileId}/series/${data.seriesId}`);
      } else {
        const startsAt = oneOffDate ? new Date(oneOffDate).getTime() : NaN;
        if (!Number.isFinite(startsAt) || startsAt <= 0) { setError("Pick a date and time."); setBusy(false); return; }
        const payload: CreateGigPayload = { profileId, ...contentInput, budget: budgetInput, startsAt, location: locationInput };
        const { data } = await httpsCallable<CreateGigPayload, { gigId: string }>(
          getFirebase().functions, "createGig")(payload);
        router.push(`/dashboard/curator/${profileId}/gigs/${data.gigId}`);
      }
    } catch (e) {
      // Surfaces server errors verbatim, including the geocode failure
      // message and (for series) the resource-exhausted active-series cap —
      // createGig itself has no cap check (that's publishGig's job, on the
      // gig editor page), so a one-off's cap error can't appear here.
      setError(e instanceof Error ? e.message : "Could not create this.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", display: "grid", gap: 24 }}>
      <a href={`/dashboard/curator/${profileId}/gigs`} style={{ color: "#666", fontSize: 14 }}>← Gigs & series</a>
      <h1>Post a gig</h1>
      <div style={{ display: "flex", gap: 8 }}>
        {([false, true] as const).map((s) => (
          <button key={String(s)} type="button" onClick={() => setIsSeries(s)}
            style={{ padding: 10, borderRadius: 8, border: "1px solid #bbb",
              background: isSeries === s ? "#111" : "#fff", color: isSeries === s ? "#fff" : "#111" }}>
            {s ? "Recurring series" : "One-off gig"}
          </button>
        ))}
      </div>
      <ContentFields value={content} onChange={setContent} />
      <BudgetFields value={budget} onChange={setBudget} />
      <ProvisionsFields value={provisions} onChange={setProvisions} />
      {isSeries ? (
        <RecurrenceFields value={recurrence} onChange={setRecurrence} />
      ) : (
        <label>When: <input type="datetime-local" value={oneOffDate} onChange={(e) => setOneOffDate(e.target.value)} /></label>
      )}
      <LocationFields isVenue={isVenue} addressRequired={!isVenue} currentLabel={currentLabel}
        value={effectiveLocation}
        onChange={(v) => { setVisibilityTouched(true); setLocation(v); }} />
      {error && (
        <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
          {error}
        </p>
      )}
      <button onClick={submit} disabled={busy} style={{ padding: 12, fontSize: 16 }}>
        {busy ? "Creating…" : isSeries ? "Create series" : "Create gig (draft)"}
      </button>
    </main>
  );
}
