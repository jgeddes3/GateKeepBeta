"use client";
import { use, useEffect, useState } from "react";
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

const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// The actual content editor — keyed by gigId (not gig.updatedAt) by the
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
    // visibility — updateGig treats an omitted location as "leave it
    // untouched," skipping a redundant re-geocode + private-doc rewrite.
    // Anything actually typed in the address field always counts as an
    // override and re-geocodes, even if it happens to match what's on file —
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
    <section style={{ display: "grid", gap: 12 }}>
      <ContentFields value={content} onChange={setContent} />
      <BudgetFields value={budget} onChange={setBudget} />
      <label>When: <input type="datetime-local" value={startsAtInput} onChange={(e) => setStartsAtInput(e.target.value)} /></label>
      <ProvisionsFields value={provisions} onChange={setProvisions} />
      <LocationFields isVenue={isVenue} addressRequired={false} currentLabel={currentLabel} value={location} onChange={setLocation} />
      {error && (
        <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
          {error}
        </p>
      )}
      <button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
    </section>
  );
}

// Both a standalone one-off gig's editor AND the destination "occurrence
// edit routes to the gig editor" sends a series occurrence to — updateGig
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
  // changes" pattern — see PortfolioEditor's identical `bookingProfileId`
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

  if (loading || !user || profile === "loading" || gig === "loading" || privateLoc === "loading") return <main><p>Loading…</p></main>;
  if (!profile || !gig) return <main><p>Gig not found.</p></main>;

  const subtype = profile.subtype as CuratorSubtype;
  const isVenue = subtype === "venue";
  const currentLabel = privateLoc
    ? `Currently on file: ${privateLoc.address} (${gig.location.addressVisibility === "public" ? "shown publicly" : "neighborhood only, publicly"})`
    : "No exact address on file.";
  // Mirrors updateGig's own gate exactly — cancelled/taken_down gigs reject
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
      // here verbatim — this is the one place that error can ever surface.
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
    <main style={{ maxWidth: 640, margin: "40px auto", display: "grid", gap: 20 }}>
      <a href={`/dashboard/curator/${profileId}/gigs`} style={{ color: "#666", fontSize: 14 }}>← Gigs & series</a>
      <h1>{gig.title || "Untitled gig"}</h1>
      <p style={{ margin: 0 }}>Status: <strong>{GIG_STATUS_LABEL[gig.status]}</strong></p>
      {gig.seriesId && (
        <div style={{ background: gig.detachedFromTemplate ? "#f3f4f6" : "#fef3c7", border: "1px solid #e5e7eb", borderRadius: 8, padding: 12 }}>
          {gig.detachedFromTemplate
            ? "This date was edited directly and no longer follows its series' template."
            : "Part of a recurring series — saving any change here will detach this date from the series; future template edits won't apply to it anymore."}
          {" "}<a href={`/dashboard/curator/${profileId}/series/${gig.seriesId}`}>View series →</a>
        </div>
      )}
      {!editable && <p style={{ color: "#666" }}>This gig is {GIG_STATUS_LABEL[gig.status].toLowerCase()} and can no longer be edited.</p>}
      {editable && <GigEditForm key={gigId} gigId={gigId} gig={gig} isVenue={isVenue} currentLabel={currentLabel} />}
      {gig.status === "draft" && (
        <section style={{ display: "grid", gap: 8, borderTop: "1px solid #eee", paddingTop: 16 }}>
          <button onClick={publish} disabled={publishBusy} style={{ padding: 12, fontSize: 16 }}>
            {publishBusy ? "Publishing…" : "Publish"}
          </button>
          {publishError && (
            <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
              {publishError}
            </p>
          )}
        </section>
      )}
      {(gig.status === "draft" || gig.status === "open") && (
        <button onClick={cancel} disabled={cancelBusy}
          style={{ color: "#dc2626", justifySelf: "start", background: "none", border: "1px solid #fca5a5", borderRadius: 6, padding: "6px 12px" }}>
          {cancelBusy ? "Cancelling…" : "Cancel this gig"}
        </button>
      )}
    </main>
  );
}
