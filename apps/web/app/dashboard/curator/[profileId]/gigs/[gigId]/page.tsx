"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { doc, onSnapshot, getDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../../../../../src/lib/firebase";
import { useAuth } from "../../../../../../src/auth/AuthProvider";
import {
  ContentFields, BudgetFields, ProvisionsFields, LocationFields,
  contentFrom, provisionsFrom, budgetFrom, MAX_ADDRESS_LENGTH, GIG_STATUS_LABEL,
  type ContentState, type ProvisionsState, type BudgetState, type LocationValue, type UpdateGigPayload,
} from "../../../../../../src/gigs/GigForms";
import {
  validateGigContent, validateBudget,
  type ProfileDoc, type CuratorSubtype, type GigDoc, type GigPrivateLocation, type GigContentInput, type GigBudget,
} from "@gatekeep/shared";
import { Button } from "../../../../../../src/ui/button";
import { Badge } from "../../../../../../src/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../../../src/ui/card";
import { Input } from "../../../../../../src/ui/input";
import { Skeleton } from "../../../../../../src/ui/skeleton";
import { IconWarning } from "../../../../../../src/ui/icons";

const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

type GigStatusBadgeVariant = "secondary" | "outline" | "success" | "warning" | "destructive";
const GIG_STATUS_BADGE: Record<GigDoc["status"], GigStatusBadgeVariant> = {
  draft: "secondary", open: "success", filled: "outline", closed: "secondary", cancelled: "destructive", taken_down: "warning",
};

// The actual content editor: keyed by gigId (not gig.updatedAt) by the
// parent below, so it seeds its local state ONCE from the first snapshot and
// never again: neither a live update from elsewhere (e.g. runDailySweep
// closing this gig) nor this form's own save (which echoes right back
// through the parent's onSnapshot) should wipe in-progress edits. Same
// contract as CuratorForms.tsx's AboutForm/LocationForm.
function GigEditForm({ gigId, gig, isVenue, currentLabel }: {
  gigId: string; gig: GigDoc; isVenue: boolean; currentLabel: string;
}) {
  const [content, setContent] = useState<ContentState>(contentFrom(gig));
  const [budget, setBudget] = useState<BudgetState>(budgetFrom(gig.budget));
  const [provisions, setProvisions] = useState<ProvisionsState>(provisionsFrom(gig.provisions));
  const [location, setLocation] = useState<LocationValue>({ address: "", visibility: gig.location.addressVisibility });
  const [startsAtInput, setStartsAtInput] = useState(toLocalInput(gig.startsAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    const startsAt = startsAtInput ? new Date(startsAtInput).getTime() : NaN;
    if (!Number.isFinite(startsAt) || startsAt <= 0) { setError("Pick a valid date and time."); return; }

    const trimmedAddress = location.address.trim();
    if (trimmedAddress.length > MAX_ADDRESS_LENGTH) { setError(`Address must be at most ${MAX_ADDRESS_LENGTH} characters.`); return; }
    // Omit `location` entirely (rather than resending an unchanged one) when
    // the curator neither typed a new address nor picked a different
    // visibility: updateGig treats an omitted location as "leave it
    // untouched," skipping a redundant re-geocode + private-doc rewrite.
    // Anything actually typed in the address field always counts as an
    // override and re-geocodes, even if it happens to match what's on file:
    // a rare, harmless extra lookup, not a correctness bug.
    const locationChanged = trimmedAddress.length > 0 || location.visibility !== gig.location.addressVisibility;

    setBusy(true);
    try {
      const payload: UpdateGigPayload = locationChanged
        ? { gigId, ...contentInput, budget: budgetInput, startsAt,
            location: { address: trimmedAddress || null, addressVisibility: location.visibility } }
        : { gigId, ...contentInput, budget: budgetInput, startsAt };
      await httpsCallable(getFirebase().functions, "updateGig")(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save changes.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardContent><ContentFields value={content} onChange={setContent} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Budget</CardTitle></CardHeader>
        <CardContent><BudgetFields value={budget} onChange={setBudget} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>When</CardTitle></CardHeader>
        <CardContent>
          <div className="grid max-w-64 gap-1.5">
            <label htmlFor="gig-edit-when" className="font-sora text-sm font-medium text-gk-text">Date and time</label>
            <Input id="gig-edit-when" type="datetime-local" value={startsAtInput} onChange={(e) => setStartsAtInput(e.target.value)} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Provisions</CardTitle></CardHeader>
        <CardContent><ProvisionsFields value={provisions} onChange={setProvisions} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Location</CardTitle></CardHeader>
        <CardContent>
          <LocationFields isVenue={isVenue} addressRequired={false} currentLabel={currentLabel} value={location} onChange={setLocation} />
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
        {busy ? "Saving…" : "Save changes"}
      </Button>
    </div>
  );
}

// Both a standalone one-off gig's editor AND the destination "occurrence
// edit routes to the gig editor" sends a series occurrence to: updateGig
// treats both identically (same callable, same detachment side effect for
// anything with a seriesId), so one page correctly serves both.
export default function GigEditor(props: { params: Promise<{ profileId: string; gigId: string }> }) {
  const { profileId, gigId } = use(props.params);
  const { user, loading } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileDoc | null | "loading">("loading");
  const [gig, setGig] = useState<GigDoc | null | "loading">("loading");
  const [privateLoc, setPrivateLoc] = useState<GigPrivateLocation | null | "loading">("loading");
  // Render-time reset (React's documented "adjust state when a prop
  // changes" pattern, see PortfolioEditor's identical `bookingProfileId`
  // trick) for the private/location one-shot getDoc below: navigating from
  // one gig's editor to another's (same route/component, different gigId)
  // does NOT remount this page, so without this, the second gig's page would
  // show the first gig's stale exact address until the new getDoc resolves.
  const [privLocGigId, setPrivLocGigId] = useState(gigId);
  if (gigId !== privLocGigId) { setPrivLocGigId(gigId); setPrivateLoc("loading"); }
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

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
    return onSnapshot(doc(db, "gigs", gigId),
      (s) => setGig(s.exists() ? (s.data() as GigDoc) : null),
      () => setGig(null));
  }, [user, gigId]);
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    // `cancelled` guards a stale WRITE the same way PortfolioEditor's booking
    // effect does: navigating gig A's editor -> gig B's can let A's getDoc
    // resolve after B's effect has already started.
    let cancelled = false;
    void getDoc(doc(db, `gigs/${gigId}/private/location`))
      .then((s) => { if (!cancelled) setPrivateLoc(s.exists() ? (s.data() as GigPrivateLocation) : null); })
      .catch(() => { if (!cancelled) setPrivateLoc(null); });
    return () => { cancelled = true; };
  }, [user, gigId]);

  if (loading || !user || profile === "loading" || gig === "loading" || privateLoc === "loading") {
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
  if (!profile || !gig) {
    return (
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16 text-center sm:px-6">
        <p className="font-syne text-lg font-semibold text-gk-text">Gig not found</p>
        <Button asChild className="mt-4"><Link href={`/dashboard/curator/${profileId}/gigs`}>Back to gigs</Link></Button>
      </main>
    );
  }

  const subtype = profile.subtype as CuratorSubtype;
  const isVenue = subtype === "venue";
  const currentLabel = privateLoc
    ? `Currently on file: ${privateLoc.address} (${gig.location.addressVisibility === "public" ? "shown publicly" : "neighborhood only, publicly"})`
    : "No exact address on file.";
  // Mirrors updateGig's own gate exactly: cancelled/taken_down gigs reject
  // the callable outright, so the edit form is hidden rather than left live
  // and doomed to a failed-precondition on save. "closed" (auto-closed past
  // gigs) is deliberately still editable, matching the server, which places
  // no restriction on it.
  const editable = gig.status !== "cancelled" && gig.status !== "taken_down";

  const publish = async () => {
    setPublishBusy(true); setPublishError(null);
    try {
      await httpsCallable(getFirebase().functions, "publishGig")({ gigId });
    } catch (e) {
      // The MAX_OPEN_GIGS_PER_PROFILE cap error (resource-exhausted) lands
      // here verbatim: this is the one place that error can ever surface.
      setPublishError(e instanceof Error ? e.message : "Could not publish.");
    } finally {
      setPublishBusy(false);
    }
  };
  const cancel = async () => {
    if (!window.confirm(`Cancel "${gig.title}"? Musicians will no longer see or apply to it. This can't be undone.`)) return;
    setCancelBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "cancelGig")({ gigId });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not cancel this gig.");
    } finally {
      setCancelBusy(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <Link href={`/dashboard/curator/${profileId}/gigs`} className="font-sora text-sm text-gk-muted hover:text-gk-text">
        &larr; Gigs &amp; series
      </Link>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">{gig.title || "Untitled gig"}</h1>
        <Badge variant={GIG_STATUS_BADGE[gig.status]}>{GIG_STATUS_LABEL[gig.status]}</Badge>
      </div>

      {gig.seriesId && (
        <div
          className={
            gig.detachedFromTemplate
              ? "mt-4 flex items-start gap-2 rounded-gk border border-gk-border bg-gk-border/20 px-3.5 py-2.5 font-sora text-sm text-gk-muted"
              : "mt-4 flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
          }
        >
          <p>
            {gig.detachedFromTemplate
              ? "This date was edited directly and no longer follows its series' template."
              : "Part of a recurring series: saving any change here will detach this date from the series. Future template edits won't apply to it anymore."}
            {" "}
            <Link href={`/dashboard/curator/${profileId}/series/${gig.seriesId}`} className="underline underline-offset-4">
              View series
            </Link>
          </p>
        </div>
      )}

      {!editable && (
        <p className="mt-6 font-sora text-sm text-gk-muted">
          This gig is {GIG_STATUS_LABEL[gig.status].toLowerCase()} and can no longer be edited.
        </p>
      )}
      {editable && (
        <div className="mt-6">
          <GigEditForm key={gigId} gigId={gigId} gig={gig} isVenue={isVenue} currentLabel={currentLabel} />
        </div>
      )}

      {gig.status === "draft" && (
        <section className="mt-8 grid gap-3 border-t border-gk-border pt-8">
          <Button type="button" onClick={publish} disabled={publishBusy} className="justify-self-start">
            {publishBusy ? "Publishing…" : "Publish"}
          </Button>
          {publishError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
            >
              <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <p>{publishError}</p>
            </div>
          )}
        </section>
      )}
      {(gig.status === "draft" || gig.status === "open") && (
        <Button type="button" variant="link" onClick={cancel} disabled={cancelBusy}
          className="mt-4 h-auto justify-self-start p-0 text-gk-destructive">
          {cancelBusy ? "Cancelling…" : "Cancel this gig"}
        </Button>
      )}
    </main>
  );
}
