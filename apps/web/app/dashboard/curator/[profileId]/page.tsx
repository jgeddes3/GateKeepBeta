"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebase } from "../../../../src/lib/firebase";
import { callFn } from "../../../../src/lib/callable";
import { useAuth } from "../../../../src/auth/AuthProvider";
import { AboutForm, LocationForm, LookingForForm, AmenitiesForm, GalleryPhotosSection } from "../../../../src/curator/CuratorForms";
import { BookingInbox } from "../../../../src/bookings/BookingInbox";
import { DelinquencyBanner } from "../../../../src/payments/DelinquencyBanner";
import { validateLookingFor, type ProfileDoc, type ProfileStatus, type CuratorDetails, type CuratorSubtype } from "@gatekeep/shared";
import { Button } from "../../../../src/ui/button";
import { Badge } from "../../../../src/ui/badge";
import { Skeleton } from "../../../../src/ui/skeleton";
import { IconCheck, IconCircle, IconWarning } from "../../../../src/ui/icons";

// Same status -> tint mapping as the musician portfolio editor and the
// dashboard's profile cards. Exhaustive over ProfileStatus, so the header
// badge always reads a real state.
const STATUS_BADGE: Record<ProfileStatus, { variant: "secondary" | "warning" | "success" | "destructive"; label: string }> = {
  draft: { variant: "secondary", label: "Draft" },
  pending_review: { variant: "warning", label: "Pending review" },
  approved: { variant: "success", label: "Approved" },
  rejected: { variant: "destructive", label: "Rejected" },
};

// Mirrors functions/src/profiles.ts's submitProfileForReview curator gate
// EXACTLY: about, >=1 photo, a location (venues need a street address;
// planners/hosts a city is enough), and a valid `lookingFor` (>=1 genre,
// >=1 act size, validateLookingFor is the same shared validator the server
// runs). The labels here are copied verbatim from that file's `missing`
// array so the checklist below and the sentence hint read identically to
// what the server would say if this client-side lock were ever bypassed.
const REQUIREMENTS: { label: string; done: (c: CuratorDetails | undefined, subtype: CuratorSubtype) => boolean }[] = [
  { label: "an about description", done: (c) => !!c?.about?.trim() },
  { label: "at least one photo", done: (c) => !!c?.photoPaths?.length },
  { label: "a location", done: (c, subtype) => (subtype === "venue" ? !!c?.location?.address : !!c?.location?.city) },
  { label: "what you're looking for", done: (c) =>
      validateLookingFor(c?.lookingFor ?? { genres: [], actSizes: [], notes: null }).ok },
];

function EditorSkeleton() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <Skeleton className="h-4 w-24" />
      <div className="mt-4 flex items-center gap-3">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
      <div className="mt-8 grid gap-6" role="status" aria-label="Loading your curator profile">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-gk border border-gk-border bg-gk-surface p-6">
            <Skeleton className="h-5 w-32" />
            <div className="mt-4 space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

export default function CuratorEditor(props: { params: Promise<{ profileId: string }> }) {
  const { profileId } = use(props.params); // client components unwrap params with use()
  const { user, loading } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileDoc | null | "loading">("loading");
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  // A single onSnapshot subscription, re-run when profileId changes: no
  // extra render-time reset needed here (contrast PortfolioEditor's
  // `bookingProfileId` trick): that trick exists there specifically for a
  // one-shot getDoc's staleness window, which this page has no equivalent
  // of. onSnapshot's own unsubscribe-then-resubscribe on profileId change is
  // the same mechanism PortfolioEditor relies on for ITS `profile` field.
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", profileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null),
      () => setProfile(null));
  }, [user, profileId]);

  if (loading || !user || profile === "loading") return <EditorSkeleton />;
  if (!profile || profile.type !== "curator") {
    return (
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16 text-center sm:px-6">
        <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
          <IconWarning size={20} aria-hidden="true" />
        </span>
        <p className="mt-3 font-syne text-lg font-semibold text-gk-text">No curator profile here</p>
        <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
          This profile doesn&apos;t exist, or it isn&apos;t a curator profile tied to your account.
        </p>
        <Button asChild className="mt-4">
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      </main>
    );
  }

  const subtype = profile.subtype as CuratorSubtype;
  const c = profile.curator;
  const missing = REQUIREMENTS.filter((r) => !r.done(c, subtype)).map((r) => r.label);
  const canSubmit = missing.length === 0;
  const showSubmit = profile.status === "draft" || profile.status === "rejected";
  const status = STATUS_BADGE[profile.status];

  const submit = async () => {
    setSubmitBusy(true);
    setSubmitError(null);
    try {
      await callFn("submitProfileForReview", { profileId });
    } catch (e) {
      // The 24h resubmit cooldown (failed-precondition) and the 1-pending-
      // curator-profile cap (resource-exhausted) both land here verbatim:
      // this banner (not window.alert, unlike the other forms' plain-alert
      // failures) is the "friendly wrapper" the brief calls for, a curator
      // who did everything right and just has to wait deserves better than
      // a modal dialog. Also the backstop for the ordinary submit-gate race
      // the client-side `missing` check above hasn't caught up to yet.
      setSubmitError(e instanceof Error ? e.message : "Could not submit.");
    } finally {
      setSubmitBusy(false);
    }
  };

  const deleteDraft = async () => {
    const ok = window.confirm(
      `Delete "${profile.name}"? This permanently deletes the profile and its photos, ` +
      `and releases the handle @${profile.handle}. This can't be undone.`);
    if (!ok) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await callFn("deleteProfile", { profileId });
      router.push("/dashboard");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Could not delete this profile.");
      setDeleteBusy(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <Link href="/dashboard" className="font-sora text-sm text-gk-muted hover:text-gk-text">
        &larr; Dashboard
      </Link>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">{profile.name}</h1>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      {profile.status === "approved" && (
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
          <Button asChild variant="link" className="h-auto p-0">
            <a href={`/@${profile.handle}`} target="_blank" rel="noopener noreferrer">View public page</a>
          </Button>
          <Button asChild variant="link" className="h-auto p-0">
            <Link href={`/dashboard/curator/${profileId}/gigs`}>Gigs &amp; series</Link>
          </Button>
          <Button asChild variant="link" className="h-auto p-0">
            <Link href={`/dashboard/curator/${profileId}/musicians`}>Find musicians</Link>
          </Button>
        </div>
      )}
      {profile.status === "rejected" && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-gk border border-gk-destructive/40 bg-gk-destructive/14 px-3.5 py-2.5 font-sora text-sm text-gk-destructive"
        >
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p><span className="font-semibold">Changes requested.</span> {profile.rejectionReason ?? "No reason provided."}</p>
        </div>
      )}
      {/* SP5 Task 15: only an approved curator profile can have bookings at
          all (same gate the Bookings section below is already behind), so
          only an approved profile can ever actually BE delinquent. Internals
          untouched (Task 11 owns this component); only its position on the
          page moved into the restyled header block. */}
      {profile.status === "approved" && (
        <div className="mt-4">
          <DelinquencyBanner profileId={profileId} />
        </div>
      )}

      {/* Every section below stays mounted and editable regardless of
          status (draft/pending_review/rejected/approved): there's no
          separate "wizard" vs "editor" component split; the sections ARE
          the wizard, and they keep working post-approval as the edit-in-
          place editor, live instantly via the onSnapshot subscription
          above. Keyed by profileId (mirrors PortfolioEditor's
          BioGenresForm/LinksForm): these forms seed local state from
          `initial` only once, on mount, so navigating from one curator
          profile's editor to another's must remount them rather than reuse
          stale state under new route params. Each key is PREFIXED per
          section, not bare `profileId`: React checks key uniqueness across
          ALL of a parent's children, not just same-component siblings, and
          four sections sharing one literal key value throws exactly the
          "two children with the same key" console error (caught live
          during this task's own browser walkthrough, see the identical
          fix+comment on the dashboard page's ProfilesList/NotificationsList
          keys). */}
      <div className="mt-8 grid gap-6">
        <AboutForm key={`about-${profileId}`} profileId={profileId} initial={c?.about} />
        <GalleryPhotosSection profileId={profileId} uid={user.uid} photoPaths={c?.photoPaths ?? []} />
        <LocationForm key={`location-${profileId}`} profileId={profileId} subtype={subtype} initial={c?.location} />
        <LookingForForm key={`looking-for-${profileId}`} profileId={profileId} initial={c?.lookingFor} />
        <AmenitiesForm
          key={`amenities-${profileId}`}
          profileId={profileId}
          initial={c?.amenities}
          initialAdvertising={c?.advertisingInterest}
        />

        {profile.status === "approved" && (
          // Only an approved curator profile can have bookings at all
          // (applyToGig/offerGig both require requireApprovedCuratorProfile),
          // mirrors the musician portfolio editor's identical gate. Keyed
          // by profileId so switching profiles under this same route resets
          // BookingInbox's three onSnapshot subscriptions instead of reusing
          // the previous profile's listeners against new params.
          <section className="border-t border-gk-border pt-8">
            <h2 className="font-syne text-lg font-semibold text-gk-text">Bookings</h2>
            <div className="mt-3">
              <BookingInbox key={profileId} profileId={profileId} role="curator" />
            </div>
          </section>
        )}

        {showSubmit && (
          <section className="grid gap-3 border-t border-gk-border pt-8">
            <h2 className="font-syne text-lg font-semibold text-gk-text">Ready to submit?</h2>
            <ul className="grid gap-1.5">
              {REQUIREMENTS.map((r) => {
                const done = r.done(c, subtype);
                return (
                  <li
                    key={r.label}
                    className={done ? "flex items-center gap-2 font-sora text-sm text-gk-success" : "flex items-center gap-2 font-sora text-sm text-gk-muted"}
                  >
                    {done
                      ? <IconCheck size={16} className="shrink-0" aria-hidden="true" />
                      : <IconCircle size={16} className="shrink-0" aria-hidden="true" />}
                    {r.label}
                  </li>
                );
              })}
            </ul>
            {!canSubmit && (
              <p className="rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
                {/* Same construction as the server's failed-precondition message
                    (functions/src/profiles.ts): reads identically to what the
                    server would say if this lock were somehow bypassed. */}
                Add {new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(missing)} before submitting.
              </p>
            )}
            <Button type="button" onClick={submit} disabled={!canSubmit || submitBusy} className="justify-self-start">
              {submitBusy ? "Submitting…" : profile.status === "rejected" ? "Resubmit for review" : "Submit for review"}
            </Button>
            {submitError && (
              <p
                role="alert"
                className="rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
              >
                {submitError}
              </p>
            )}
            <Button
              type="button"
              variant="link"
              className="h-auto justify-self-start p-0 text-gk-destructive"
              onClick={deleteDraft}
              disabled={deleteBusy}
            >
              {deleteBusy ? "Deleting…" : "Delete this profile"}
            </Button>
            {deleteError && (
              <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
                <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                {deleteError}
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
