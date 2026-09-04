"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebase } from "../../../../../../src/lib/firebase";
import { callFn } from "../../../../../../src/lib/callable";
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
import { Chip } from "../../../../../../src/portfolio/PortfolioForms";
import { Button } from "../../../../../../src/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../../../src/ui/card";
import { Input } from "../../../../../../src/ui/input";
import { Skeleton } from "../../../../../../src/ui/skeleton";
import { IconWarning } from "../../../../../../src/ui/icons";

// The composer's one-off/series fork mirrors /join's musician/curator toggle
// exactly (same "click a chip, the form below reshapes" pattern): a single
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

  if (loading || !user || profile === "loading") {
    return (
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14" role="status" aria-label="Loading">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-4 h-9 w-48" />
        <div className="mt-8 grid gap-6">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      </main>
    );
  }
  if (!profile || profile.type !== "curator") {
    return (
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16 text-center sm:px-6">
        <p className="font-syne text-lg font-semibold text-gk-text">No curator profile here</p>
        <Button asChild className="mt-4"><Link href="/dashboard">Back to dashboard</Link></Button>
      </main>
    );
  }
  if (profile.status !== "approved") {
    return (
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16 text-center sm:px-6">
        <p className="font-sora text-sm text-gk-muted">Your curator profile must be approved before you can post gigs.</p>
        <Button asChild variant="link" className="mt-2 h-auto p-0">
          <Link href={`/dashboard/curator/${profileId}`}>&larr; Back to profile</Link>
        </Button>
      </main>
    );
  }

  const subtype = profile.subtype as CuratorSubtype;
  const isVenue = subtype === "venue";
  // Same defaulting rule resolveGigLocation applies server-side
  // (isVenue ? "public" : "neighborhood"), computed at render time from the
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
        const { data } = await callFn<CreateSeriesPayload, { seriesId: string }>("createSeries", payload);
        router.push(`/dashboard/curator/${profileId}/series/${data.seriesId}`);
      } else {
        const startsAt = oneOffDate ? new Date(oneOffDate).getTime() : NaN;
        if (!Number.isFinite(startsAt) || startsAt <= 0) { setError("Pick a date and time."); setBusy(false); return; }
        const payload: CreateGigPayload = { profileId, ...contentInput, budget: budgetInput, startsAt, location: locationInput };
        const { data } = await callFn<CreateGigPayload, { gigId: string }>("createGig", payload);
        router.push(`/dashboard/curator/${profileId}/gigs/${data.gigId}`);
      }
    } catch (e) {
      // Surfaces server errors verbatim, including the geocode failure
      // message and (for series) the resource-exhausted active-series cap:
      // createGig itself has no cap check (that's publishGig's job, on the
      // gig editor page), so a one-off's cap error can't appear here.
      setError(e instanceof Error ? e.message : "Could not create this.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <Link href={`/dashboard/curator/${profileId}/gigs`} className="font-sora text-sm text-gk-muted hover:text-gk-text">
        &larr; Gigs &amp; series
      </Link>
      <h1 className="mt-4 font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Post a gig</h1>

      <div className="mt-6 grid gap-6">
        <div className="flex flex-wrap gap-2">
          {([false, true] as const).map((s) => (
            <Chip key={String(s)} active={isSeries === s} onClick={() => setIsSeries(s)}>
              {s ? "Recurring series" : "One-off gig"}
            </Chip>
          ))}
        </div>

        <Card>
          <CardHeader><CardTitle>Details</CardTitle></CardHeader>
          <CardContent><ContentFields value={content} onChange={setContent} /></CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Budget</CardTitle></CardHeader>
          <CardContent><BudgetFields value={budget} onChange={setBudget} /></CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{isSeries ? "Schedule" : "When"}</CardTitle></CardHeader>
          <CardContent>
            {isSeries ? (
              <RecurrenceFields value={recurrence} onChange={setRecurrence} />
            ) : (
              <div className="grid max-w-64 gap-1.5">
                <label htmlFor="gig-when" className="font-sora text-sm font-medium text-gk-text">Date and time</label>
                <Input id="gig-when" type="datetime-local" value={oneOffDate} onChange={(e) => setOneOffDate(e.target.value)} />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Provisions</CardTitle></CardHeader>
          <CardContent><ProvisionsFields value={provisions} onChange={setProvisions} /></CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Location</CardTitle></CardHeader>
          <CardContent>
            <LocationFields isVenue={isVenue} addressRequired={!isVenue} currentLabel={currentLabel}
              value={effectiveLocation}
              onChange={(v) => { setVisibilityTouched(true); setLocation(v); }} />
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

        <Button type="button" onClick={submit} disabled={busy} className="justify-self-start">
          {busy ? "Creating…" : isSeries ? "Create series" : "Create gig (draft)"}
        </Button>
      </div>
    </main>
  );
}
