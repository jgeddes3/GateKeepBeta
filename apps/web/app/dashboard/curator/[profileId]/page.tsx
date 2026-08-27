"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../../../src/lib/firebase";
import { useAuth } from "../../../../src/auth/AuthProvider";
import { AboutForm, LocationForm, LookingForForm, AmenitiesForm, GalleryPhotosSection } from "../../../../src/curator/CuratorForms";
import { BookingInbox } from "../../../../src/bookings/BookingForms";
import { validateLookingFor, type ProfileDoc, type CuratorDetails, type CuratorSubtype } from "@gatekeep/shared";

// Mirrors functions/src/profiles.ts's submitProfileForReview curator gate
// EXACTLY: about, >=1 photo, a location (venues need a street address;
// planners/hosts a city is enough), and a valid `lookingFor` (>=1 genre,
// >=1 act size — validateLookingFor is the same shared validator the server
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

export default function CuratorEditor(props: { params: Promise<{ profileId: string }> }) {
  const { profileId } = use(props.params); // client components unwrap params with use()
  const { user, loading } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileDoc | null | "loading">("loading");
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  // A single onSnapshot subscription, re-run when profileId changes — no
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

  if (loading || !user || profile === "loading") return <main><p>Loading…</p></main>;
  if (!profile || profile.type !== "curator") return <main><p>No curator profile here.</p></main>;

  const subtype = profile.subtype as CuratorSubtype;
  const c = profile.curator;
  const missing = REQUIREMENTS.filter((r) => !r.done(c, subtype)).map((r) => r.label);
  const canSubmit = missing.length === 0;
  const showSubmit = profile.status === "draft" || profile.status === "rejected";

  const submit = async () => {
    setSubmitBusy(true);
    setSubmitError(null);
    try {
      await httpsCallable(getFirebase().functions, "submitProfileForReview")({ profileId });
    } catch (e) {
      // The 24h resubmit cooldown (failed-precondition) and the 1-pending-
      // curator-profile cap (resource-exhausted) both land here verbatim —
      // this banner (not window.alert, unlike the other forms' plain-alert
      // failures) is the "friendly wrapper" the brief calls for: a curator
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
    try {
      await httpsCallable(getFirebase().functions, "deleteProfile")({ profileId });
      router.push("/dashboard");
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not delete this profile.");
      setDeleteBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 760, margin: "40px auto", display: "grid", gap: 32 }}>
      <h1>{profile.name} — curator profile</h1>
      <p>
        Status: <strong>{profile.status.replace("_", " ")}</strong>
        {profile.status === "approved" && (
          <>
            {" "}· <a href={`/@${profile.handle}`} target="_blank" rel="noopener noreferrer">view public page</a>
            {" "}· <a href={`/dashboard/curator/${profileId}/gigs`}>gigs & series</a>
            {" "}· <a href={`/dashboard/curator/${profileId}/musicians`}>find musicians</a>
          </>
        )}
      </p>
      {profile.status === "rejected" && (
        <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, padding: 12 }}>
          <strong>Changes requested:</strong> {profile.rejectionReason ?? "(no reason provided)"}
        </div>
      )}
      {/* Every section below stays mounted and editable regardless of
          status (draft/pending_review/rejected/approved) — there's no
          separate "wizard" vs "editor" component split; the sections ARE
          the wizard, and they keep working post-approval as the edit-in-
          place editor, live instantly via the onSnapshot subscription
          above. Keyed by profileId (mirrors PortfolioEditor's
          BioGenresForm/LinksForm): these forms seed local state from
          `initial` only once, on mount, so navigating from one curator
          profile's editor to another's must remount them rather than reuse
          stale state under new route params. Each key is PREFIXED per
          section, not bare `profileId` — React checks key uniqueness across
          ALL of a parent's children, not just same-component siblings, and
          four sections sharing one literal key value throws exactly the
          "two children with the same key" console error (caught live
          during this task's own browser walkthrough — see the identical
          fix+comment on the dashboard page's ProfilesList/NotificationsList
          keys). */}
      <AboutForm key={`about-${profileId}`} profileId={profileId} initial={c?.about} />
      <GalleryPhotosSection profileId={profileId} uid={user.uid} photoPaths={c?.photoPaths ?? []} />
      <LocationForm key={`location-${profileId}`} profileId={profileId} subtype={subtype} initial={c?.location} />
      <LookingForForm key={`looking-for-${profileId}`} profileId={profileId} initial={c?.lookingFor} />
      <AmenitiesForm key={`amenities-${profileId}`} profileId={profileId} initial={c?.amenities} initialAdvertising={c?.advertisingInterest} />
      {profile.status === "approved" && (
        // Only an approved curator profile can have bookings at all
        // (applyToGig/offerGig both require requireApprovedCuratorProfile)
        // — mirrors the musician portfolio editor's identical gate. Keyed
        // by profileId so switching profiles under this same route resets
        // BookingInbox's three onSnapshot subscriptions instead of reusing
        // the previous profile's listeners against new params.
        <section style={{ borderTop: "1px solid #eee", paddingTop: 24 }}>
          <h2>Bookings</h2>
          <BookingInbox key={profileId} profileId={profileId} role="curator" />
        </section>
      )}
      {showSubmit && (
        <section style={{ display: "grid", gap: 8, borderTop: "1px solid #eee", paddingTop: 24 }}>
          <h2>Ready to submit?</h2>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {REQUIREMENTS.map((r) => {
              const done = r.done(c, subtype);
              return (
                <li key={r.label} style={{ color: done ? "#16a34a" : "#92400e" }}>
                  {done ? "✓" : "○"} {r.label}
                </li>
              );
            })}
          </ul>
          <button onClick={submit} disabled={!canSubmit || submitBusy} style={{ padding: 12, fontSize: 16 }}>
            {submitBusy ? "Submitting…" : profile.status === "rejected" ? "Resubmit for review" : "Submit for review"}
          </button>
          {!canSubmit && (
            <p style={{ color: "#92400e", margin: 0 }}>
              {/* Same construction as the server's failed-precondition message
                  (functions/src/profiles.ts) — reads identically to what the
                  server would say if this lock were somehow bypassed. */}
              Add {new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(missing)} before submitting.
            </p>
          )}
          {submitError && (
            <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
              {submitError}
            </p>
          )}
          <button onClick={deleteDraft} disabled={deleteBusy}
            style={{ color: "#dc2626", justifySelf: "start", background: "none", border: "1px solid #fca5a5", borderRadius: 6, padding: "6px 12px" }}>
            {deleteBusy ? "Deleting…" : "Delete this profile"}
          </button>
        </section>
      )}
    </main>
  );
}
