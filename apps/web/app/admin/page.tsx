"use client";
import { useEffect, useState, useRef, type ReactNode } from "react";
import {
  collection, collectionGroup, query, where, onSnapshot, orderBy, limit, getDoc, getDocs, doc,
  type DocumentReference,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getDownloadURL, ref as storageRef } from "firebase/storage";
import { getFirebase } from "../../src/lib/firebase";
import { AdminGate } from "./AdminGate";
import { GIG_STATUS_LABEL, formatGigDateTime } from "../../src/gigs/GigForms";
import { bookingHistoryLabel } from "../../src/bookings/BookingInbox";
import { Chip, formatChipLabel } from "../../src/portfolio/PortfolioForms";
import { Button } from "../../src/ui/button";
import { Badge } from "../../src/ui/badge";
import { Card, CardContent } from "../../src/ui/card";
import { Input } from "../../src/ui/input";
import { Textarea } from "../../src/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../src/ui/select";
import { Switch } from "../../src/ui/switch";
import { Skeleton } from "../../src/ui/skeleton";
import { IconGigs, IconInfo, IconUser, IconWarning } from "../../src/ui/icons";
import {
  GIG_STATUSES,
  type ProfileDoc, type ProfileStatus, type AuditLogDoc, type UserDoc, type TrackDoc, type GigDoc, type GigStatus,
  type CuratorSubtype, type AdminNoteDoc, type ReliabilityMark, type ReliabilityDoc, type BookingRequestDoc,
  type AdminAlertDoc, type AdminAlertKind,
} from "@gatekeep/shared";

// Task 12: full-polish restyle of the admin dashboard, per antislop-ui's App
// & Dashboard rule ("build around the reviewer's actual decision"). Every
// query and callable below is byte-identical to the pre-restyle version
// (same collections, fields, limits, orderings, payload shapes); only the
// markup, styling, and (where the brief calls it out) the reason-collection
// flow changed. window.prompt()'s five reason-collecting call sites (profile
// reject, track reject, gig takedown, profile unpublish, track removal) are
// replaced by ReasonCard below, an inline styled panel generalizing the
// shape CancelDialog.tsx already established for booking cancellation
// (border-gk-destructive card, Textarea with a live counter, inline error,
// Confirm/Back buttons), so the review queue's rejection input finally reads
// as a designed control instead of an unstyled browser dialog.

type Row<T> = T & { id: string };
type BadgeVariant = "secondary" | "outline" | "success" | "warning" | "destructive";

// Resolves one public/photos/... path to a displayable thumbnail URL, same
// three-state (null while resolving / "error" / resolved url) pattern as
// TrackQueueRow's review-clip resolution below, reused here so reviewers can
// actually see the avatar/cover they're approving (finding 2: the checklist
// below told admins to "check submitted details for impersonation" without
// ever showing them those details).
function PhotoThumb({ path, alt }: { path: string | null | undefined; alt: string }) {
  const [url, setUrl] = useState<string | null | "error">(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    void getDownloadURL(storageRef(getFirebase().storage, path))
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch((e) => {
        console.error("PhotoThumb: getDownloadURL failed", path, e);
        if (!cancelled) setUrl("error");
      });
    return () => { cancelled = true; };
  }, [path]);
  if (!path) return null;
  if (url === "error") return <p className="font-sora text-xs text-gk-destructive">{alt} unavailable</p>;
  if (!url) return <p className="font-sora text-xs text-gk-muted">{alt} loading…</p>;
  return (
    <img src={url} alt={alt} className="h-20 w-20 shrink-0 rounded-gk-sm border border-gk-border object-cover" />
  );
}

// Resolves the uid of the profile's owner: the member whose role is "admin"
// who joined earliest (createProfileDraft always writes exactly one such
// member, {uid, role:"admin", label:"owner"}, at creation time; inviteMember
// can add further admin-role members later, so "earliest joinedAt" rather
// than "the only admin" picks the original creator when more than one
// exists). Used by QueueRow's reject-with-flag flow below to know WHO
// flagAccount's uid should target, since ProfileDoc itself carries no
// owner-uid field. Fetches the whole (small, single-digit) members
// subcollection rather than an equality+orderBy query, deliberately: that
// combination needs its own composite index, which doesn't exist (and this
// task is web-only, no backend/index changes), so sorting client-side over
// an unfiltered read is the return-nothing-new-to-deploy option. Returns
// null if the profile somehow has no admin-role member (shouldn't happen in
// practice, but the caller surfaces that as a "couldn't flag" error rather
// than assuming).
async function resolveProfileOwnerUid(profileId: string): Promise<string | null> {
  const { db } = getFirebase();
  const snap = await getDocs(collection(db, `profiles/${profileId}/members`));
  const admins = snap.docs
    .map((d) => ({ uid: d.id, ...(d.data() as { role: string; joinedAt: number }) }))
    .filter((m) => m.role === "admin")
    .sort((a, b) => a.joinedAt - b.joinedAt);
  return admins[0]?.uid ?? null;
}

// Shared shell for every "collect a reason, then commit a destructive
// decision" flow on this page (profile reject, track reject, gig takedown,
// profile unpublish, track removal): a solid destructive-tinted card with a
// counted Textarea, an inline error banner, and Confirm/Back buttons. Visual
// shape is CancelDialog.tsx's (task 11), generalized: that component keeps
// its own booking-specific window math and callable inline, this one is pure
// chrome, controlled entirely by the caller (reason state, submit handler,
// busy/error). `extra` is an optional slot for a call-site-specific control
// rendered between the textarea and the error banner (QueueRow's "also flag
// this account" toggle is the one user).
//
// The maxLength=500 default (and every caller's own trimmed-length 1-500
// check before calling onSubmit) mirrors the identical 1-500 bound
// reviewProfile/reviewTrack/takedownGig already enforce server-side
// (functions/src/review.ts, tracks.ts, gigs.ts): this is a friendlier
// client-side echo of an existing server rule, not a new one, so the
// persisted `rejectionReason`/takedown reason is unaffected either way.
// Where a caller's pre-restyle window.prompt() flow had a looser or no
// client check (several only tested for non-empty), the server's own
// validation was always the real backstop; see task 12's report for the
// per-call-site diff.
function ReasonCard({
  title, warning, maxLength = 500, placeholder = "Reason (required)",
  reason, onReasonChange, busy, error, onSubmit, onCancel, submitLabel, busyLabel, extra,
}: {
  title: string;
  warning?: string;
  maxLength?: number;
  placeholder?: string;
  reason: string;
  onReasonChange: (v: string) => void;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  busyLabel: string;
  extra?: ReactNode;
}) {
  return (
    <Card className="border-gk-destructive/40 bg-gk-destructive/14 p-4">
      <CardContent className="grid gap-3 p-0">
        <p className="font-syne text-base font-semibold text-gk-text">{title}</p>
        {warning && (
          <p className="flex items-start gap-2 font-sora text-sm text-gk-destructive">
            <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {warning}
          </p>
        )}
        <div className="grid gap-1">
          <Textarea rows={3} maxLength={maxLength} value={reason} disabled={busy}
            onChange={(e) => onReasonChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
          <p className="font-sora text-xs text-gk-muted">{reason.length}/{maxLength}</p>
        </div>
        {extra}
        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
            <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button onClick={onSubmit} disabled={busy} variant="destructive">
            {busy ? busyLabel : submitLabel}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Back</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Quiet loading placeholder for the four top-level list sections (profile
// queue, track queue, gig moderation, audit log): a handful of card-shaped
// skeletons rather than a bare spinner (antislop R-27/DESIGN.md "every async
// surface gets a content-shaped skeleton").
function CardRowsSkeleton({ count = 2, label }: { count?: number; label: string }) {
  return (
    <div className="grid gap-3" role="status" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-gk border border-gk-border bg-gk-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-9 w-24 shrink-0" />
          </div>
        </div>
      ))}
    </div>
  );
}

// A small inline "nothing here right now" line: an icon plus a named cause
// and, where one exists, what fills the section next. Matches BookingInbox's
// InboxEmpty (task 11) rather than dashboard's bigger centered "you have
// literally nothing yet" block: an empty review queue is a working-as-
// intended state, not an account-level first.
function SectionEmpty({ icon: Icon, children }: { icon: typeof IconUser; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 font-sora text-sm text-gk-muted">
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}

function GuidanceBanner({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-text">
      <IconInfo size={16} className="mt-0.5 shrink-0 text-gk-warning" aria-hidden="true" />
      {children}
    </p>
  );
}

// Owns the Approve/Reject actions (and their in-flight/error state) for
// exactly one queue row. A per-row component, rather than a shared
// in-flight-ids array on Queue, keeps the busy flag local state instead of
// a setState update derived from an effect, matching the keyed-component
// reset pattern used elsewhere in this app (dashboard's ProfilesList,
// AdminGate's ClaimCheck).
//
// Finding 2: reviewers were approving bio/photos/genres/links sight-unseen,
// the checklist below said "check submitted details for impersonation" but
// nothing on this row showed those details. Musician portfolios show their
// portfolio block; curator profiles (Task 12) show the curator gate-fields
// block below instead, each type only has one of the two.
//
// Task 12 also adds an optional "also flag this account" toggle next to
// Reject: when on, flagAccount is called AFTER reviewProfile's reject
// commits (never before, a flag on an account whose reject then fails would
// leave a flag with nothing to explain it). Both calls share this row's one
// `busyAction` lock, so nothing else on the row can fire mid two-step
// sequence.
function QueueRow({ p }: { p: Row<ProfileDoc> }) {
  const [busyAction, setBusyAction] = useState<"approve" | "reject" | null>(null);
  const busy = busyAction !== null;
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState("");
  const [flagChecked, setFlagChecked] = useState(false);
  const [flagNote, setFlagNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    setBusyAction("approve"); setError(null);
    try {
      await httpsCallable(getFirebase().functions, "reviewProfile")({ profileId: p.id, decision: "approved" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit the review, try again.");
    } finally {
      setBusyAction(null);
    }
  };

  const submitReject = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      setError("Rejection reason must be 1-500 characters.");
      return;
    }
    const trimmedFlagNote = flagNote.trim();
    if (flagChecked && (trimmedFlagNote.length < 1 || trimmedFlagNote.length > 500)) {
      setError('Enter a note (1-500 characters) for "also flag this account", or turn it off.');
      return;
    }
    setBusyAction("reject"); setError(null);
    try {
      const { functions } = getFirebase();
      await httpsCallable(functions, "reviewProfile")({ profileId: p.id, decision: "rejected", reason: trimmed });
      if (flagChecked) {
        try {
          const ownerUid = await resolveProfileOwnerUid(p.id);
          if (!ownerUid) throw new Error("Could not find an account on this profile to flag.");
          await httpsCallable(functions, "flagAccount")({ uid: ownerUid, text: trimmedFlagNote });
          // Only clear the flag fields once the flag itself actually landed.
          // The reject above already committed regardless of what happens
          // here, so a flagAccount failure below must not erase the note the
          // admin typed: they still need it to retry.
          setFlagChecked(false); setFlagNote("");
        } catch (flagError) {
          window.alert(
            `The review was submitted, but the account flag failed: ${
              flagError instanceof Error ? flagError.message : "try flagging from User lookup instead."
            }`,
          );
        }
      }
      // The reject decision itself is final either way, so the reason panel
      // always closes here: this reset is unconditional on the OUTER
      // reviewProfile call succeeding, independent of the flag outcome above.
      setShowReject(false); setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit the review, try again.");
    } finally {
      setBusyAction(null);
    }
  };

  const pf = p.type === "musician" ? p.portfolio : undefined;
  const curator = p.type === "curator" ? p.curator : undefined;
  // Same https-only display filter as the public /u/[handle] page and the
  // mobile artist screen, belt-and-suspenders even though
  // validatePortfolioUpdate already enforces this at write time.
  const links = (pf?.externalLinks ?? []).filter((l) => l.url.startsWith("https://"));

  return (
    <Card>
      <CardContent className="grid gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-syne text-base font-semibold text-gk-text">{p.name}</p>
              <span className="font-sora text-sm text-gk-muted">@{p.handle}</span>
              <Badge variant="secondary">
                {p.type === "musician" ? "Musician" : "Curator"} · {formatChipLabel(p.subtype)}
              </Badge>
              {typeof p.resubmitCount === "number" && p.resubmitCount > 0 && (
                <Badge variant="warning">resubmitted ×{p.resubmitCount}</Badge>
              )}
            </div>
            <p className="mt-1 font-sora text-xs text-gk-muted">
              Submitted {new Date(p.updatedAt).toLocaleString()}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" disabled={busy} onClick={approve}>
              {busyAction === "approve" ? "Approving…" : "Approve"}
            </Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => setShowReject((s) => !s)}>
              Reject
            </Button>
          </div>
        </div>

        {curator && (
          <div className="grid gap-1 font-sora text-sm text-gk-text">
            <p className="text-gk-muted">
              {curator.photoPaths.length} photo{curator.photoPaths.length === 1 ? "" : "s"}
              {" · "}{curator.location.address ?? curator.location.city}
            </p>
            {curator.lookingFor.genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {curator.lookingFor.genres.map((g) => <Badge key={g} variant="secondary">{formatChipLabel(g)}</Badge>)}
              </div>
            )}
            {curator.lookingFor.actSizes.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {curator.lookingFor.actSizes.map((a) => <Badge key={a} variant="secondary">{formatChipLabel(a)}</Badge>)}
              </div>
            )}
            {curator.about && (
              <p className="whitespace-pre-wrap">
                {curator.about.length > 240 ? `${curator.about.slice(0, 240)}…` : curator.about}
              </p>
            )}
            {!curator.about && curator.lookingFor.genres.length === 0 && curator.lookingFor.actSizes.length === 0
              && curator.photoPaths.length === 0 && (
              <p className="text-gk-muted">No curator details submitted.</p>
            )}
          </div>
        )}
        {pf && (
          <div className="flex gap-3">
            <div className="flex shrink-0 gap-2">
              <PhotoThumb path={pf.avatarPhotoPath} alt="Avatar" />
              <PhotoThumb path={pf.coverPhotoPath} alt="Cover" />
            </div>
            <div className="min-w-0 grid gap-1.5 font-sora text-sm text-gk-text">
              {pf.genres.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {pf.genres.map((g) => <Badge key={g} variant="secondary">{formatChipLabel(g)}</Badge>)}
                </div>
              )}
              {pf.bio && <p className="whitespace-pre-wrap">{pf.bio}</p>}
              {links.length > 0 && (
                <p className="flex flex-wrap gap-3">
                  {links.map((l) => (
                    <a key={`${l.kind}:${l.url}`} href={l.url} target="_blank" rel="noopener noreferrer nofollow"
                      className="text-gk-text underline hover:text-gk-accent">
                      {l.kind}
                    </a>
                  ))}
                </p>
              )}
              {!pf.bio && pf.genres.length === 0 && links.length === 0 && !pf.avatarPhotoPath && !pf.coverPhotoPath && (
                <p className="text-gk-muted">No portfolio content submitted.</p>
              )}
            </div>
          </div>
        )}

        {showReject && (
          <ReasonCard
            title="Reject this profile"
            placeholder="Rejection reason (shown to the applicant)"
            reason={reason} onReasonChange={setReason}
            busy={busyAction === "reject"} error={error}
            onSubmit={submitReject} onCancel={() => { setShowReject(false); setError(null); }}
            submitLabel="Confirm reject" busyLabel="Rejecting…"
            extra={
              <div className="grid gap-2">
                <label className="flex items-center gap-2 font-sora text-sm text-gk-text">
                  <Switch checked={flagChecked} disabled={busyAction === "reject"}
                    onCheckedChange={setFlagChecked} />
                  Also flag this account
                </label>
                {flagChecked && (
                  <Textarea rows={2} maxLength={500} value={flagNote} disabled={busyAction === "reject"}
                    onChange={(e) => setFlagNote(e.target.value)}
                    placeholder="Flag note (shown only to admins)" aria-label="Flag note" />
                )}
              </div>
            }
          />
        )}
        {error && !showReject && (
          <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
            <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Queue() {
  const [pending, setPending] = useState<Row<ProfileDoc>[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "profiles"), where("status", "==", "pending_review")),
      (s) => { setPending(s.docs.map((d) => ({ id: d.id, ...(d.data() as ProfileDoc) }))); setLoaded(true); },
    );
  }, []);
  return (
    <section className="grid gap-3">
      <h2 className="font-syne text-lg font-semibold text-gk-text">
        Profile queue{loaded ? ` (${pending.length})` : ""}
      </h2>
      {/* Review checklist per spec §6: shown to the reviewing admin, not just a code comment. */}
      <GuidanceBanner>
        Before approving: verify this is really them. Check the name, handle, and submitted details for
        impersonation.
      </GuidanceBanner>
      {!loaded ? (
        <CardRowsSkeleton label="Loading the profile queue" />
      ) : pending.length === 0 ? (
        <SectionEmpty icon={IconUser}>Queue&rsquo;s clear. New profile submissions land here.</SectionEmpty>
      ) : (
        <div className="grid gap-3">{pending.map((p) => <QueueRow key={p.id} p={p} />)}</div>
      )}
    </section>
  );
}

type TrackRow = Row<TrackDoc> & { profileId: string; profileName: string };

// Owns the Approve/Reject actions for exactly one pending track, same
// per-row-busy-state rationale as QueueRow above. Also resolves and plays the
// review clip inline (spec §6: admin listens before approving), via
// getDownloadURL on the track's review/... storagePath, admins can read any
// review clip under storage.rules. url is three-state: null while resolving
// (loading placeholder), "error" if getDownloadURL rejects (e.g. the object
// is missing, surfaced as an explicit dead-end rather than an infinite
// "clip loading…", since nothing will ever move it out of that state), or
// the resolved string. storagePath is typed nullable on TrackDoc (other
// statuses can have no file yet); the transcode trigger only ever writes
// status:"pending_review" and storagePath together in the same update, so in
// practice every row here has one, but the effect still guards against a
// falsy path rather than assuming that invariant.
function TrackQueueRow({ t }: { t: TrackRow }) {
  const [busyAction, setBusyAction] = useState<"approve" | "reject" | null>(null);
  const busy = busyAction !== null;
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null | "error">(null);
  useEffect(() => {
    if (!t.storagePath) return;
    let cancelled = false;
    void getDownloadURL(storageRef(getFirebase().storage, t.storagePath))
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch((e) => {
        console.error("TrackQueueRow: getDownloadURL failed", t.storagePath, e);
        if (!cancelled) setUrl("error");
      });
    return () => { cancelled = true; };
  }, [t.storagePath]);

  const approve = async () => {
    setBusyAction("approve"); setError(null);
    try {
      await httpsCallable(getFirebase().functions, "reviewTrack")(
        { profileId: t.profileId, trackId: t.id, decision: "approved" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit the review, try again.");
    } finally {
      setBusyAction(null);
    }
  };
  const submitReject = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      setError("Rejection reason must be 1-500 characters.");
      return;
    }
    setBusyAction("reject"); setError(null);
    try {
      await httpsCallable(getFirebase().functions, "reviewTrack")(
        { profileId: t.profileId, trackId: t.id, decision: "rejected", reason: trimmed });
      setShowReject(false); setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit the review, try again.");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <Card>
      <CardContent className="grid gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-syne text-base font-semibold text-gk-text">{t.title}</p>
            <p className="font-sora text-sm text-gk-muted">
              {t.profileName} · {t.durationSec ?? "?"}s
            </p>
            <p className="mt-1 font-sora text-xs text-gk-muted">
              Submitted {new Date(t.updatedAt).toLocaleString()}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" disabled={busy} onClick={approve}>
              {busyAction === "approve" ? "Approving…" : "Approve"}
            </Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => setShowReject((s) => !s)}>
              Reject
            </Button>
          </div>
        </div>
        {t.storagePath == null
          ? <p className="font-sora text-sm text-gk-muted">No clip on file.</p>
          : url === "error"
            ? <p className="font-sora text-sm text-gk-destructive">Clip unavailable, reject and ask the musician to re-upload.</p>
            : url
              ? <audio controls preload="none" src={url} className="w-full" />
              : <p className="font-sora text-sm text-gk-muted">clip loading…</p>}

        {showReject && (
          <ReasonCard
            title="Reject this track"
            placeholder="Rejection reason (shown to the musician)"
            reason={reason} onReasonChange={setReason}
            busy={busyAction === "reject"} error={error}
            onSubmit={submitReject} onCancel={() => { setShowReject(false); setError(null); }}
            submitLabel="Confirm reject" busyLabel="Rejecting…"
          />
        )}
        {error && !showReject && (
          <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
            <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// Pending-track review queue (spec §6). collectionGroup('tracks') mirrors
// Queue's flat collection query above, but tracks live under
// profiles/{profileId}/tracks, collectionGroup + the admin CG-read rule and
// fieldOverride index (already in place) is what makes a single
// cross-profile "everything pending" listener possible. Bounded with
// limit(100), same reasoning as AuditLog's limit(50): an admin listener
// should never fan out unboundedly. This intentionally doesn't order by
// createdAt (i.e. isn't FIFO-oldest-first): collectionGroup + an equality
// filter + orderBy on a different field needs its own composite index,
// which doesn't exist yet; deferred until the queue realistically nears
// this cap and ordering starts to matter.
//
// Each snapshot also resolves the parent profile doc for its name
// (deleted-profile-safe, same "(deleted)" fallback the mobile/web
// dashboards use elsewhere), batched via Promise.all over the *unique*
// profile ids in this snapshot (several pending tracks routinely share a
// profile), not one sequential getDoc per track. Two race guards on top of
// that N+1 resolution, since it's async work hanging off a listener that
// can fire again before it finishes: `cancelled` (composed into the
// cleanup, same convention as UserProfiles below) for unmount, and a
// monotonic `seq` token so a slower, older snapshot's resolution can never
// finish after and repaint over a newer one's already-committed state.
function TracksQueue() {
  const [pending, setPending] = useState<TrackRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const { db } = getFirebase();
    let cancelled = false;
    let seq = 0;
    const unsubscribe = onSnapshot(
      query(collectionGroup(db, "tracks"), where("status", "==", "pending_review"), limit(100)),
      async (s) => {
        const mySeq = ++seq;
        const profileRefs = new Map<string, DocumentReference>();
        for (const d of s.docs) {
          const profileRef = d.ref.parent.parent;
          if (!profileRef) continue;
          profileRefs.set(profileRef.id, profileRef);
        }
        const nameEntries = await Promise.all(
          Array.from(profileRefs.values()).map(async (profileRef) => {
            const p = await getDoc(profileRef);
            return [profileRef.id, p.exists() ? (p.data() as ProfileDoc).name : "(deleted)"] as const;
          }),
        );
        if (cancelled || mySeq !== seq) return;
        const names = new Map(nameEntries);
        const rows: TrackRow[] = [];
        for (const d of s.docs) {
          const profileRef = d.ref.parent.parent;
          if (!profileRef) continue;
          rows.push({
            id: d.id,
            profileId: profileRef.id,
            profileName: names.get(profileRef.id) ?? "(deleted)",
            ...(d.data() as TrackDoc),
          });
        }
        setPending(rows);
        setLoaded(true);
      },
    );
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  return (
    <section className="grid gap-3">
      <h2 className="font-syne text-lg font-semibold text-gk-text">
        Track queue{loaded ? ` (${pending.length})` : ""}
      </h2>
      {/* Screening guidance per spec §6: admins hear exactly what the public would. */}
      <GuidanceBanner>
        You are hearing exactly what the public would hear. Screening call: does this sound like the
        artist&rsquo;s own performance (not AI-generated, not someone else&rsquo;s recording)? When unsure, reject with
        a note asking for context.
      </GuidanceBanner>
      {!loaded ? (
        <CardRowsSkeleton label="Loading the track queue" />
      ) : pending.length === 0 ? (
        <SectionEmpty icon={IconGigs}>Queue&rsquo;s clear. New track submissions land here.</SectionEmpty>
      ) : (
        <div className="grid gap-3">{pending.map((t) => <TrackQueueRow key={`${t.profileId}-${t.id}`} t={t} />)}</div>
      )}
    </section>
  );
}

const NON_VENUE_SUBTYPES = new Set<CuratorSubtype>(["planner", "individual_host"]);

// taken_down is a moderation action (admin-issued): it must not read as just
// another flavor of the curator's own routine cancellation, so it gets its
// own "warning" tint distinct from cancelled's "destructive" red. Mirrors
// the curator gigs list's own GIG_STATUS_BADGE (apps/web/app/dashboard/
// curator/[profileId]/gigs/page.tsx) exactly, for one consistent status
// vocabulary product-wide; duplicated locally rather than imported since
// that page only exports the map implicitly via a module-private const.
const GIG_STATUS_BADGE: Record<GigDoc["status"], BadgeVariant> = {
  draft: "secondary", open: "success", filled: "outline", closed: "secondary", cancelled: "destructive", taken_down: "warning",
};

type GigModRow = Row<GigDoc> & {
  curatorName: string; curatorHandle: string | null; curatorSubtype: CuratorSubtype | null;
};

// Owns the takedown action (and its busy/error state) for exactly one gig
// row, same per-row-component rationale as QueueRow/TrackQueueRow above.
// Series occurrences get a choice of scope (backend's takedownGig requires
// scope:"series" to actually own a seriesId, so the series button is simply
// absent otherwise rather than being shown-then-rejected); a standalone gig
// only ever gets the one "this date" button. `scope` doubles as "which
// ReasonCard is open", since only one takedown can be mid-confirmation at a time.
function GigModerationRow({ g }: { g: GigModRow }) {
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<"occurrence" | "series" | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      setError("Reason must be 1-500 characters.");
      return;
    }
    setBusy(true); setError(null);
    try {
      await httpsCallable(getFirebase().functions, "takedownGig")({ gigId: g.id, scope, reason: trimmed });
      setScope(null); setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not take down the gig, try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="grid gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-syne text-base font-semibold text-gk-text">{g.title || "Untitled gig"}</p>
              <Badge variant={GIG_STATUS_BADGE[g.status]}>{GIG_STATUS_LABEL[g.status]}</Badge>
            </div>
            <p className="mt-1 font-sora text-sm text-gk-muted">
              {g.curatorHandle
                ? <a href={`/u/${g.curatorHandle}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-gk-text">{g.curatorName}</a>
                : g.curatorName}
              {" · "}{formatGigDateTime(g.startsAt)}
            </p>
          </div>
          {g.status !== "taken_down" && (
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="secondary" className="text-gk-destructive" disabled={busy}
                onClick={() => { setScope("occurrence"); setError(null); }}>
                Take down this date
              </Button>
              {g.seriesId && (
                <Button size="sm" variant="secondary" className="text-gk-destructive" disabled={busy}
                  onClick={() => { setScope("series"); setError(null); }}>
                  Take down series
                </Button>
              )}
            </div>
          )}
        </div>
        {scope && (
          <ReasonCard
            title={scope === "series" ? "Take down the entire series" : "Take down this date"}
            warning={scope === "series"
              ? "This removes this date and every other open date in the series, and pauses the series."
              : "This removes this date immediately."}
            placeholder="Takedown reason (shown to the curator)"
            reason={reason} onReasonChange={setReason}
            busy={busy} error={error}
            onSubmit={submit} onCancel={() => { setScope(null); setError(null); }}
            submitLabel="Confirm takedown" busyLabel="Taking down…"
          />
        )}
      </CardContent>
    </Card>
  );
}

// Status filter (default "open", the actionable moderation queue; other
// statuses are there for the "did I already handle this" / "what happened
// to it" lookback) + subtype toggle (default non-venue, spec's trust split:
// individually-run planner/host gigs get eyes-on moderation, venue gigs
// default OFF the list since venues clear an address-verification bar
// venues-only at approval time (see profiles.ts's hasLocation check) that
// planners/hosts don't).
//
// GigDoc carries no subtype of its own (only curatorProfileId), the
// admin-readable gigs query is by status alone, and curator subtype comes
// from a second, batched read: same N+1-avoidance shape as TracksQueue's
// profile-name resolution above (Promise.all over the *unique*
// curatorProfileIds in the current snapshot), just carrying subtype+handle
// alongside name instead of name alone. Same two race guards too
// (`cancelled` for unmount, monotonic `seq` so a slower/older snapshot's
// resolution can't finish after and repaint over a newer one).
// The rows + loaded flag live in their own component, mounted with
// key={status} by GigsAdmin below, so switching the status filter remounts
// (and thus resets `loaded` to false) via React's own keyed-remount
// mechanism instead of an explicit setState call inside the effect body
// (the React Compiler's react-hooks/set-state-in-effect rule forbids that
// synchronous reset), matching the keyed-component reset pattern used
// throughout this file (dashboard's ProfilesList, AdminGate's ClaimCheck).
function GigsAdminList({ status, showVenue }: { status: GigStatus; showVenue: boolean }) {
  const [rows, setRows] = useState<GigModRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const { db } = getFirebase();
    let cancelled = false;
    let seq = 0;
    const unsubscribe = onSnapshot(
      // P9: limit(100), same reasoning as TracksQueue's/AuditLog's identical
      // caps, an admin moderation listener over a status filter that can
      // legitimately match thousands of docs (e.g. "closed" or "cancelled"
      // over the platform's whole gig history) must not pull the entire
      // result set into the browser on every snapshot.
      query(collection(db, "gigs"), where("status", "==", status), limit(100)),
      async (s) => {
        const mySeq = ++seq;
        const docs = s.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) }));
        const curatorIds = Array.from(new Set(docs.map((g) => g.curatorProfileId)));
        const entries = await Promise.all(
          curatorIds.map(async (id) => {
            const p = await getDoc(doc(db, "profiles", id));
            return [id, p.exists() ? (p.data() as ProfileDoc) : null] as const;
          }),
        );
        if (cancelled || mySeq !== seq) return;
        const curators = new Map(entries);
        setRows(docs.map((g) => {
          const p = curators.get(g.curatorProfileId);
          return {
            ...g,
            curatorName: p?.name ?? "(deleted)",
            curatorHandle: p?.handle ?? null,
            curatorSubtype: p ? (p.subtype as CuratorSubtype) : null,
          };
        }));
        setLoaded(true);
      },
    );
    return () => { cancelled = true; unsubscribe(); };
  }, [status]);

  const filtered = rows.filter((g) => (
    showVenue ? g.curatorSubtype === "venue" : g.curatorSubtype === null || NON_VENUE_SUBTYPES.has(g.curatorSubtype)
  ));

  if (!loaded) return <CardRowsSkeleton label="Loading gigs" />;
  if (filtered.length === 0) {
    return (
      <SectionEmpty icon={IconGigs}>
        No gigs match this filter. Try a different status, or toggle venue gigs.
      </SectionEmpty>
    );
  }
  return <div className="grid gap-3">{filtered.map((g) => <GigModerationRow key={g.id} g={g} />)}</div>;
}

function GigsAdmin() {
  const [status, setStatus] = useState<GigStatus>("open");
  const [showVenue, setShowVenue] = useState(false);

  return (
    <section className="grid gap-3">
      <h2 className="font-syne text-lg font-semibold text-gk-text">Gig moderation</h2>
      <div className="flex flex-wrap items-center gap-6">
        <label className="flex items-center gap-2 font-sora text-sm text-gk-text">
          Status
          <Select value={status} onValueChange={(v) => setStatus(v as GigStatus)}>
            <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              {GIG_STATUSES.map((s) => <SelectItem key={s} value={s}>{GIG_STATUS_LABEL[s]}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <div>
          <label className="flex items-center gap-2 font-sora text-sm text-gk-text">
            <Switch checked={showVenue} onCheckedChange={setShowVenue} />
            Show venue gigs
          </label>
          <p className="mt-1 font-sora text-xs text-gk-muted">Default: planners and individual hosts only.</p>
        </div>
      </div>
      <GigsAdminList key={status} status={status} showVenue={showVenue} />
    </section>
  );
}

// SP4 Task 11's reliability panel, profiles/{profileId}/private/reliability,
// admin-readable per firestore.rules (`allow read: if isMember(profileId) ||
// isAdmin();`). Musician-only (a curator profile has no reliability doc, the
// mark record is keyed to the MUSICIAN side of a booking; see
// ReliabilityMark/ReliabilityDoc in packages/shared/src/types.ts), only
// mounted when profile.type === "musician" (TakedownsPanel below). Same
// load-on-id-change idiom as UserProfiles/AdminNotes above ("loading"
// sentinel as the useState initial value, own `cancelled` guard), mounted
// with `key={profileId}` so a fresh lookup remounts it fresh rather than
// needing an imperative reset inside the effect. A per-row busy lock, keyed
// by `${bookingId}-${kind}` (the exact pair removeReliabilityMark matches
// against, a booking can carry at most one mark of each kind), mirrors
// QueueRow/TrackQueueRow's per-row busy state.
function ReliabilityPanel({ profileId }: { profileId: string }) {
  const [marks, setMarks] = useState<ReliabilityMark[] | "loading">("loading");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { db } = getFirebase();
      const snap = await getDoc(doc(db, `profiles/${profileId}/private/reliability`));
      if (!cancelled) setMarks(snap.exists() ? (snap.data() as ReliabilityDoc).marks : []);
    })().catch((e) => {
      console.error("ReliabilityPanel: load failed", profileId, e);
      if (!cancelled) setMarks([]);
    });
    return () => { cancelled = true; };
  }, [profileId]);

  const remove = async (mark: ReliabilityMark) => {
    const key = `${mark.bookingId}-${mark.kind}`;
    setBusyKey(key); setRemoveError(null);
    try {
      await httpsCallable(getFirebase().functions, "removeReliabilityMark")(
        { musicianProfileId: profileId, bookingId: mark.bookingId, kind: mark.kind });
      setMarks((prev) => (prev === "loading" ? prev : prev.map((m) => (
        m.bookingId === mark.bookingId && m.kind === mark.kind ? { ...m, removedByAdmin: true } : m))));
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : "Could not remove the mark, try again.");
    } finally {
      setBusyKey(null);
    }
  };

  if (marks === "loading") return <p className="ml-4 mt-1 font-sora text-sm text-gk-muted">Loading reliability record…</p>;
  if (marks.length === 0) return <p className="ml-4 mt-1 font-sora text-sm text-gk-muted">No reliability marks.</p>;
  return (
    <div className="ml-4 mt-1 grid gap-2">
      <div className="overflow-x-auto rounded-gk-sm border border-gk-border">
        <table className="w-full min-w-[480px] border-collapse font-sora text-sm">
          <thead>
            <tr className="border-b border-gk-border bg-gk-border/20 text-left">
              <th className="px-3 py-2 font-medium text-gk-muted">Kind</th>
              <th className="px-3 py-2 font-medium text-gk-muted">Date</th>
              <th className="px-3 py-2 font-medium text-gk-muted">Source booking</th>
              <th className="px-3 py-2 font-medium text-gk-muted">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {marks.map((m) => {
              const key = `${m.bookingId}-${m.kind}`;
              return (
                <tr key={key} className="border-b border-gk-border last:border-0">
                  <td className="px-3 py-2 text-gk-text">{m.kind === "late_cancel" ? "Late cancel" : "No-show"}</td>
                  <td className="px-3 py-2 text-gk-muted">{new Date(m.at).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <a href={`/dashboard/bookings/${m.bookingId}`} target="_blank" rel="noopener noreferrer" className="text-gk-text underline hover:text-gk-accent">
                      {m.bookingId}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-gk-muted">{m.removedByAdmin ? "Removed" : "Active"}</td>
                  <td className="px-3 py-2">
                    {!m.removedByAdmin && (
                      <Button size="sm" variant="secondary" className="text-gk-destructive" disabled={busyKey === key} onClick={() => remove(m)}>
                        {busyKey === key ? "Removing…" : "Remove"}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {removeError && (
        <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {removeError}
        </p>
      )}
    </div>
  );
}

type AdminBookingRow = Row<BookingRequestDoc>;

// SP4 Task 11's per-profile bookings list, a profile id sits on EITHER side
// of a booking (curatorProfileId or musicianProfileId, never both: a
// profile id is only ever one type, musician or curator), so both queries
// fire unconditionally rather than branching on profile.type, matching the
// task brief's "either side, two queries, statuses any" shape and keeping
// this component profile-type-agnostic (at most one of the two ever returns
// rows for a given profileId in practice). Admin read is provable via
// firestore.rules' bookings rule's isAdmin() disjunct alone, it doesn't
// depend on resource.data, so it holds for every result regardless of
// status, the same way the gigs rule's isAdmin() disjunct does. Same
// load-on-id-change idiom as ReliabilityPanel above (mounted with
// `key={profileId}` by TakedownsPanel, so a fresh lookup remounts fresh
// "loading" state rather than needing an imperative reset).
function ProfileBookingsList({ profileId }: { profileId: string }) {
  const [rows, setRows] = useState<AdminBookingRow[] | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { db } = getFirebase();
      const [curatorSide, musicianSide] = await Promise.all([
        getDocs(query(collection(db, "bookings"), where("curatorProfileId", "==", profileId),
          orderBy("updatedAt", "desc"), limit(25))),
        getDocs(query(collection(db, "bookings"), where("musicianProfileId", "==", profileId),
          orderBy("updatedAt", "desc"), limit(25))),
      ]);
      if (cancelled) return;
      // SP4 (Task 13 item 9): re-capped at 25 AFTER the merge, each query is
      // independently limit(25), so a profile id that (atypically, see this
      // component's own comment above) returns rows on BOTH sides could
      // otherwise show up to 50 combined, doubling the "most recent 25"
      // this list is meant to be everywhere else it's used.
      const merged = [...curatorSide.docs, ...musicianSide.docs]
        .map((d) => ({ id: d.id, ...(d.data() as BookingRequestDoc) }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 25);
      setRows(merged);
    })().catch((e) => {
      console.error("ProfileBookingsList: load failed", profileId, e);
      if (!cancelled) setRows([]);
    });
    return () => { cancelled = true; };
  }, [profileId]);

  if (rows === "loading") return <p className="ml-4 mt-1 font-sora text-sm text-gk-muted">Loading bookings…</p>;
  if (rows.length === 0) return <p className="ml-4 mt-1 font-sora text-sm text-gk-muted">No bookings.</p>;
  return (
    <ul className="ml-4 mt-1 grid gap-2">
      {rows.map((b) => (
        <li key={b.id}>
          <a href={`/dashboard/bookings/${b.id}`} target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-between gap-3 rounded-gk-sm border border-gk-border bg-gk-surface px-3 py-2 font-sora text-sm text-gk-text outline-none transition-colors hover:border-gk-accent/50 focus-visible:ring-2 focus-visible:ring-gk-focus">
            <span className="truncate">
              {b.status === "open" || b.status === "confirmed" ? b.status : bookingHistoryLabel(b)}
            </span>
            <span className="shrink-0 text-xs text-gk-muted">updated {new Date(b.updatedAt).toLocaleString()}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

const PROFILE_STATUS_BADGE: Record<ProfileStatus, { variant: BadgeVariant; label: string }> = {
  draft: { variant: "secondary", label: "Draft" },
  pending_review: { variant: "warning", label: "Pending review" },
  approved: { variant: "success", label: "Approved" },
  rejected: { variant: "destructive", label: "Rejected" },
};

// One live (approved) track's own reason-collecting remove flow, extracted
// out of TakedownsPanel so each row owns its own ReasonCard state (the
// per-row-component pattern this whole file uses elsewhere). `onRemoved`
// lets the parent drop the track from its `tracks` array on success, same
// end state the pre-restyle inline filter produced.
function LiveTrackRow({ profileId, track, onRemoved }: {
  profileId: string; track: Row<TrackDoc>; onRemoved: (trackId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [incomplete, setIncomplete] = useState(false);

  const remove = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      setError("Reason must be 1-500 characters.");
      return;
    }
    setBusy(true); setError(null);
    try {
      await httpsCallable(getFirebase().functions, "reviewTrack")(
        { profileId, trackId: track.id, decision: "rejected", reason: trimmed });
      onRemoved(track.id);
    } catch (e) {
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
      if (code === "functions/unavailable") {
        // reviewTrack already committed "rejected" before throwing this, the
        // decision is final at the transaction, storage cleanup runs after
        // (see that function's comments), so the public object may still be
        // reachable even though the doc says rejected. Don't remove the row:
        // a fresh lookup queries status=="approved", which this doc no
        // longer matches, so re-looking-up would just silently drop the row
        // and hide an incomplete takedown. Mark it instead, so the admin
        // sees it needs a retry rather than assuming it's still an ordinary
        // live track.
        setIncomplete(true);
        setShowReason(false);
      } else {
        setError(e instanceof Error ? e.message : "Could not remove the track, try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="grid gap-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-syne text-sm font-semibold text-gk-text">{track.title}</p>
            <p className="font-sora text-xs text-gk-muted">{track.durationSec ?? "?"}s</p>
          </div>
          <Button size="sm" variant="secondary" className="text-gk-destructive" disabled={busy}
            onClick={() => { setShowReason((s) => !s); setError(null); }}>
            {incomplete ? "Retry removal" : "Remove"}
          </Button>
        </div>
        {incomplete && (
          <p className="flex items-start gap-2 font-sora text-sm text-gk-warning">
            <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            Removal incomplete, retry. The track is already off review, but the public clip may still be reachable.
          </p>
        )}
        {showReason && (
          <ReasonCard
            title="Remove this track"
            warning="This removes the track from their live profile immediately."
            placeholder="Takedown reason (shown to the musician)"
            reason={reason} onReasonChange={setReason}
            busy={busy} error={error}
            onSubmit={remove} onCancel={() => { setShowReason(false); setError(null); }}
            submitLabel="Confirm removal" busyLabel="Removing…"
          />
        )}
      </CardContent>
    </Card>
  );
}

// Retroactive-takedown panel (spec §6: "admins can retroactively unpublish").
// reviewTrack already accepts decision:"rejected" against an already-approved
// track, TracksQueue above can't reach that path since it only ever lists
// pending_review tracks, so this gives admins a way in: look a profile up by
// handle, see its live (approved) tracks, remove one with a reason. Same
// handles/{handle} -> profileId indirection the public /u/[handle] route
// uses, and handles are stored lowercase there too. SP4 Task 11 additionally
// mounts a reliability panel (musician profiles only) and a bookings list
// (either type) inside this same lookup result area.
function TakedownsPanel() {
  const [handle, setHandle] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profile, setProfile] = useState<Row<ProfileDoc> | null>(null);
  const [showUnpublish, setShowUnpublish] = useState(false);
  const [unpublishReason, setUnpublishReason] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [unpublishError, setUnpublishError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Row<TrackDoc>[]>([]);
  // Guards lookup() the same way UserLookup's searchSeq guards its search():
  // the Enter-key handler and the Look-up button both call lookup(), and
  // disabling on lookupBusy narrows but doesn't fully close the window for a
  // second call to start before React commits the first's setLookupBusy(true)
  // (both can read the same stale closure mid-event). A ref (not state,
  // needs to be readable synchronously the instant a response resolves)
  // means a slower, superseded lookup's response can never overwrite a
  // newer one's already-displayed results.
  const lookupSeq = useRef(0);

  const lookup = async () => {
    const h = handle.trim().toLowerCase();
    if (!h) return;
    const mySeq = ++lookupSeq.current;
    setLookupBusy(true); setLookupError(null);
    // Clear any previous handle's results up front, so a failed lookup (or a
    // slow one) never leaves a stale profile's tracks on screen under a new
    // handle in the input.
    setProfileId(null);
    setProfile(null);
    setTracks([]);
    setShowUnpublish(false);
    try {
      const { db } = getFirebase();
      const handleDoc = await getDoc(doc(db, "handles", h));
      if (mySeq !== lookupSeq.current) return; // superseded by a newer lookup
      if (!handleDoc.exists()) { setLookupError("No profile with that handle."); return; }
      const pid = (handleDoc.data() as { profileId: string }).profileId;
      const [profileDoc, tracksSnap] = await Promise.all([
        getDoc(doc(db, "profiles", pid)),
        getDocs(query(
          collection(db, `profiles/${pid}/tracks`), where("status", "==", "approved"), orderBy("order"))),
      ]);
      if (mySeq !== lookupSeq.current) return; // superseded by a newer lookup
      setProfileId(pid);
      setProfile(profileDoc.exists() ? { id: profileDoc.id, ...(profileDoc.data() as ProfileDoc) } : null);
      setTracks(tracksSnap.docs.map((d) => ({ id: d.id, ...(d.data() as TrackDoc) })));
    } catch (e) {
      if (mySeq === lookupSeq.current) {
        setLookupError(e instanceof Error ? e.message : "Could not look up that handle, try again.");
      }
    } finally {
      if (mySeq === lookupSeq.current) setLookupBusy(false);
    }
  };

  // Retroactive profile unpublish (spec §6, item C): reviewProfile's reject
  // decision now also accepts an already-approved profile, flipping it to
  // rejected hides the profile AND all its tracks from public reads via
  // firestore.rules' profileApproved() gate, without needing to take down
  // each track individually first.
  const unpublishProfile = async () => {
    if (!profileId) return;
    const trimmed = unpublishReason.trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      setUnpublishError("Reason must be 1-500 characters.");
      return;
    }
    setProfileBusy(true); setUnpublishError(null);
    try {
      await httpsCallable(getFirebase().functions, "reviewProfile")(
        { profileId, decision: "rejected", reason: trimmed });
      setProfile((p) => (p ? { ...p, status: "rejected", rejectionReason: trimmed } : p));
      setShowUnpublish(false); setUnpublishReason("");
    } catch (e) {
      setUnpublishError(e instanceof Error ? e.message : "Could not unpublish the profile, try again.");
    } finally {
      setProfileBusy(false);
    }
  };

  return (
    <section className="grid gap-3">
      <h2 className="font-syne text-lg font-semibold text-gk-text">Takedowns</h2>
      <p className="font-sora text-sm text-gk-muted">Retroactively remove a live profile or track (spec §6).</p>
      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="@handle"
          value={handle}
          className="w-56"
          onChange={(e) => setHandle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !lookupBusy) void lookup(); }}
        />
        <Button variant="secondary" disabled={lookupBusy} onClick={lookup}>{lookupBusy ? "Looking up…" : "Look up"}</Button>
      </div>
      {lookupError && (
        <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {lookupError}
        </p>
      )}
      {profile && profileId && (
        <Card>
          <CardContent className="grid gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-syne text-base font-semibold text-gk-text">{profile.name}</p>
              <span className="font-sora text-sm text-gk-muted">@{profile.handle}</span>
              <Badge variant={PROFILE_STATUS_BADGE[profile.status].variant}>
                {PROFILE_STATUS_BADGE[profile.status].label}
              </Badge>
            </div>
            {profile.status === "approved" ? (
              <div>
                <Button size="sm" variant="secondary" className="text-gk-destructive" disabled={profileBusy}
                  onClick={() => { setShowUnpublish((s) => !s); setUnpublishError(null); }}>
                  Unpublish profile
                </Button>
              </div>
            ) : (
              <p className="font-sora text-sm text-gk-muted">Not currently live, nothing to unpublish.</p>
            )}
            {showUnpublish && (
              <ReasonCard
                title="Unpublish this profile"
                warning="This removes the profile, and everything on it, from public immediately."
                placeholder="Unpublish reason (shown to the profile's admins)"
                reason={unpublishReason} onReasonChange={setUnpublishReason}
                busy={profileBusy} error={unpublishError}
                onSubmit={unpublishProfile} onCancel={() => { setShowUnpublish(false); setUnpublishError(null); }}
                submitLabel="Confirm unpublish" busyLabel="Unpublishing…"
              />
            )}
            {profile.type === "musician" && (
              <div>
                <h3 className="font-syne text-sm font-semibold text-gk-text">Reliability record</h3>
                <ReliabilityPanel key={profileId} profileId={profileId} />
              </div>
            )}
            <div>
              <h3 className="font-syne text-sm font-semibold text-gk-text">Bookings</h3>
              <ProfileBookingsList key={profileId} profileId={profileId} />
            </div>
          </CardContent>
        </Card>
      )}
      {tracks.length > 0 && (
        <div className="grid gap-3">
          {tracks.map((t) => (
            <LiveTrackRow key={t.id} profileId={profileId!} track={t}
              onRemoved={(trackId) => setTracks((ts) => ts.filter((x) => x.id !== trackId))} />
          ))}
        </div>
      )}
      {profileId && tracks.length === 0 && <p className="font-sora text-sm text-gk-muted">No approved tracks.</p>}
    </section>
  );
}

// Loads and displays one user's profiles + statuses (spec §6: "profiles and
// statuses"), via the same collectionGroup('members').where('uid', ...)
// pattern the mobile/web dashboards use for "my profiles", admins can read
// any uid's membership docs this way (firestore.rules grants isAdmin() the
// same collection-group access as the self-read clause).
function UserProfiles({ uid }: { uid: string }) {
  const [profiles, setProfiles] = useState<Row<ProfileDoc>[] | "loading">("loading");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { db } = getFirebase();
      const memberships = await getDocs(query(collectionGroup(db, "members"), where("uid", "==", uid)));
      const out: Row<ProfileDoc>[] = [];
      for (const m of memberships.docs) {
        if (cancelled) return;
        const profileRef = m.ref.parent.parent;
        if (!profileRef) continue;
        const p = await getDoc(profileRef);
        if (cancelled) return;
        if (p.exists()) out.push({ id: p.id, ...(p.data() as ProfileDoc) });
      }
      if (!cancelled) setProfiles(out);
    })();
    return () => { cancelled = true; };
  }, [uid]);
  if (profiles === "loading") return <p className="ml-4 mt-1 font-sora text-sm text-gk-muted">Loading profiles…</p>;
  if (profiles.length === 0) return <p className="ml-4 mt-1 font-sora text-sm text-gk-muted">No profiles.</p>;
  return (
    <ul className="ml-4 mt-1 grid gap-1">
      {profiles.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center gap-2 font-sora text-sm text-gk-text">
          {p.name}
          <Badge variant="secondary">{p.type === "musician" ? "Musician" : "Curator"}</Badge>
          <Badge variant={PROFILE_STATUS_BADGE[p.status].variant}>{PROFILE_STATUS_BADGE[p.status].label}</Badge>
        </li>
      ))}
    </ul>
  );
}

// Renders adminNotes/{uid} (Task 12) inline on a user-lookup result,
// admin-read-only per firestore.rules (`match /adminNotes/{uid} { allow
// read: if isAdmin(); allow write: if false; }`), written only by
// flagAccount's Admin SDK transaction. `cancelled` guards unmount the same
// way UserProfiles above does; no unmount-race window here to compound
// (a single getDoc, not an N+1 loop), but the guard costs nothing and keeps
// this file's async-effect shape consistent.
function AdminNotes({ uid }: { uid: string }) {
  const [notes, setNotes] = useState<AdminNoteDoc["notes"] | "loading">("loading");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { db } = getFirebase();
      const snap = await getDoc(doc(db, "adminNotes", uid));
      if (cancelled) return;
      setNotes(snap.exists() ? (snap.data() as AdminNoteDoc).notes : []);
    })();
    return () => { cancelled = true; };
  }, [uid]);
  if (notes === "loading") return <p className="ml-4 mt-1 font-sora text-sm text-gk-muted">Loading notes…</p>;
  if (notes.length === 0) return null;
  return (
    <ul className="ml-4 mt-1 grid gap-1">
      {notes.map((n, i) => (
        // P9: index appended, flagAccount's transaction guarantees two
        // notes always append (never dedupe), so two flags from the SAME
        // admin within the same at-millisecond (a real possibility per
        // adminTools.ts's own comment on why arrayUnion isn't used here)
        // would otherwise collide on byUid+at alone.
        <li key={`${n.byUid}-${n.at}-${i}`} className="font-sora text-sm text-gk-destructive">
          {new Date(n.at).toLocaleString()}: {n.text}
        </li>
      ))}
    </ul>
  );
}

type LookupMode = "email" | "name";
type UserResult = { id: string; displayName: string; email: string };

// Task 12: adds a name-prefix mode (searchUsersByName, admin-only callable
// over the displayNameLower index) alongside the original exact-email path,
// via a mode toggle rather than two always-visible inputs, mirrors the
// existing single-input/single-button lookup shape instead of doubling the
// UI surface. Both paths funnel into the same UserResult shape so the
// results list below (profiles + adminNotes) is written once.
//
// `searchSeq` guards search() the same way TakedownsPanel's lookupSeq guards
// its lookup() above: a ref (not state) so a slower, superseded search's
// response can never overwrite a newer one's already-displayed results,
// relevant here specifically because switching mode mid-request or
// double-clicking Search both fire overlapping async calls.
function UserLookup() {
  const [mode, setMode] = useState<LookupMode>("email");
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const switchMode = (m: LookupMode) => {
    if (m === mode) return;
    setMode(m);
    setResults([]);
    setSearched(false);
    setSearchError(null);
  };

  const search = async () => {
    const q = term.trim();
    if (!q) return;
    const mySeq = ++searchSeq.current;
    setBusy(true);
    setSearched(true);
    setSearchError(null);
    try {
      const { db, functions } = getFirebase();
      let mapped: UserResult[];
      if (mode === "email") {
        const s = await getDocs(query(collection(db, "users"), where("email", "==", q)));
        mapped = s.docs.map((d) => {
          const data = d.data() as UserDoc;
          return { id: d.id, displayName: data.displayName, email: data.email };
        });
      } else {
        const res = await httpsCallable<{ q: string }, { results: { uid: string; displayName: string; email: string }[] }>(
          functions, "searchUsersByName",
        )({ q });
        mapped = res.data.results.map((r) => ({ id: r.uid, displayName: r.displayName, email: r.email }));
      }
      if (mySeq !== searchSeq.current) return; // superseded by a newer search
      setResults(mapped);
    } catch (e) {
      if (mySeq === searchSeq.current) {
        setSearchError(e instanceof Error ? e.message : "Search failed, try again.");
        setResults([]);
      }
    } finally {
      if (mySeq === searchSeq.current) setBusy(false);
    }
  };

  return (
    <section className="grid gap-3">
      <h2 className="font-syne text-lg font-semibold text-gk-text">User lookup</h2>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex gap-2">
          <Chip active={mode === "email"} disabled={busy} onClick={() => switchMode("email")}>Email</Chip>
          <Chip active={mode === "name"} disabled={busy} onClick={() => switchMode("name")}>Name</Chip>
        </div>
        <div className="flex flex-1 min-w-56 gap-2">
          <Input
            placeholder={mode === "email" ? "exact email" : "name prefix"}
            value={term}
            disabled={busy}
            className="max-w-xs"
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) void search(); }}
          />
          <Button variant="secondary" disabled={busy} onClick={search}>{busy ? "Searching…" : "Search"}</Button>
        </div>
      </div>
      <p className="font-sora text-xs text-gk-muted">
        {mode === "email" ? "Matches the exact email address." : "Matches the start of a display name."}
      </p>
      {searchError && (
        <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {searchError}
        </p>
      )}
      {results.length > 0 && (
        <div className="grid gap-3">
          {results.map((u) => (
            <Card key={u.id}>
              <CardContent className="p-4">
                <p className="font-sora text-sm text-gk-text">
                  {u.displayName} · {u.email} · uid {u.id}
                </p>
                <AdminNotes uid={u.id} />
                <UserProfiles key={u.id} uid={u.id} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {searched && !busy && !searchError && results.length === 0 && (
        <SectionEmpty icon={IconUser}>No match for &ldquo;{term}&rdquo;. Check the spelling, or try the other lookup mode.</SectionEmpty>
      )}
    </section>
  );
}

const AUDIT_ACTION_LABEL: Record<AuditLogDoc["action"], string> = {
  profile_approved: "Profile approved",
  profile_rejected: "Profile rejected",
  admin_granted: "Admin granted",
  profile_deleted: "Profile deleted",
  track_approved: "Track approved",
  track_rejected: "Track rejected",
  gig_taken_down: "Gig taken down",
  account_flagged: "Account flagged",
  reliability_mark_removed: "Reliability mark removed",
  booking_visibility_backfilled: "Booking visibility backfilled",
  booking_saga_released: "Booking saga released",
};

function AuditLog() {
  const [logs, setLogs] = useState<Row<AuditLogDoc>[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "auditLogs"), orderBy("at", "desc"), limit(50)),
      (s) => { setLogs(s.docs.map((d) => ({ id: d.id, ...(d.data() as AuditLogDoc) }))); setLoaded(true); },
    );
  }, []);
  return (
    <section className="grid gap-3">
      <h2 className="font-syne text-lg font-semibold text-gk-text">Audit log</h2>
      {!loaded ? (
        <div className="overflow-hidden rounded-gk border border-gk-border" role="status" aria-label="Loading the audit log">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 border-b border-gk-border p-3.5 last:border-0">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      ) : logs.length === 0 ? (
        <p className="font-sora text-sm text-gk-muted">
          No activity yet. Approvals, rejections, and moderation actions will show up here.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-gk border border-gk-border">
          <table className="w-full min-w-[720px] border-collapse font-sora text-sm">
            <thead>
              <tr className="border-b border-gk-border bg-gk-border/20 text-left">
                <th className="px-3.5 py-2.5 font-medium text-gk-muted">When</th>
                <th className="px-3.5 py-2.5 font-medium text-gk-muted">Action</th>
                <th className="px-3.5 py-2.5 font-medium text-gk-muted">Target</th>
                <th className="px-3.5 py-2.5 font-medium text-gk-muted">Actor</th>
                <th className="px-3.5 py-2.5 font-medium text-gk-muted">Detail</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="border-b border-gk-border last:border-0 hover:bg-gk-border/10">
                  <td className="whitespace-nowrap px-3.5 py-2.5 text-gk-muted">{new Date(l.at).toLocaleString()}</td>
                  <td className="px-3.5 py-2.5 text-gk-text">{AUDIT_ACTION_LABEL[l.action]}</td>
                  <td className="px-3.5 py-2.5 text-xs text-gk-muted">{l.targetId}</td>
                  <td className="px-3.5 py-2.5 text-xs text-gk-muted">{l.actorUid}</td>
                  <td className="px-3.5 py-2.5 text-gk-muted">{l.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type AlertRow = Row<AdminAlertDoc>;

const ALERT_KIND_LABEL: Record<AdminAlertKind, string> = {
  stuck_saga_marker: "Stuck accept saga",
  stale_accept_saga: "Stale accept saga",
  expired_booking_saga_marker: "Expired booking, saga still staged",
  stale_pending_deposit: "Stale pending deposit",
  settlement_raced: "Settlement raced",
  settlement_pending_stuck: "Settlement charge stuck",
  settlement_payout_blocked: "Settlement blocked, no payout account",
  deposit_pending_stuck: "Deposit charge stuck",
  deposit_raced: "Deposit raced",
  clawback_failed: "Clawback failed",
  payout_fee_uncollected: "Payout fee uncollected",
};

// Only the three saga kinds share a bookingId-keyed row an admin can act on
// from here: releaseStuckSaga (functions/src/payments.ts) refuses anything
// else (SAGA_NOT_STAGED_MESSAGE and friends), and every other alert kind is
// resolved by an operator working in Stripe directly, with no client-facing
// callable. Showing a button only for these three (and only once bookingId
// is present, the one alert kind without one, payout_fee_uncollected, is
// profile-scoped) keeps this page from offering an action that would just
// throw.
const RELEASABLE_KINDS = new Set<AdminAlertKind>(["stuck_saga_marker", "stale_accept_saga", "expired_booking_saga_marker"]);

function AdminAlertRow({ a }: { a: AlertRow }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const release = async () => {
    if (!a.bookingId) return;
    setBusy(true); setError(null);
    try {
      await httpsCallable(getFirebase().functions, "releaseStuckSaga")({ bookingId: a.bookingId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not release, try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-1.5 rounded-gk-sm border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-syne text-sm font-semibold text-gk-text">{ALERT_KIND_LABEL[a.kind]}</span>
        <span className="font-sora text-xs text-gk-muted">
          first seen {new Date(a.firstSeenAt).toLocaleString()} · seen {a.runCount}x
        </span>
      </div>
      <p className="font-sora text-sm text-gk-text">{a.detail}</p>
      {(a.bookingId || a.gigId) && (
        <p className="flex flex-wrap gap-3 font-sora text-xs text-gk-muted">
          {a.bookingId && (
            <a href={`/dashboard/bookings/${a.bookingId}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-gk-text">
              booking {a.bookingId}
            </a>
          )}
          {a.gigId && <span>gig {a.gigId}</span>}
        </p>
      )}
      {RELEASABLE_KINDS.has(a.kind) && a.bookingId && (
        <div>
          <Button size="sm" variant="secondary" disabled={busy} onClick={release}>
            {busy ? "Releasing…" : "Release stuck saga"}
          </Button>
          {error && <p role="alert" className="mt-1 font-sora text-xs text-gk-destructive">{error}</p>}
        </div>
      )}
    </div>
  );
}

// SP5's durable payments escalation queue (see AdminAlertDoc's own extensive
// comments in @gatekeep/shared): money-path conditions that resolved
// themselves out of automatic retry and are now a human's problem. Per the
// task brief, this section is surfaced ONLY when there is something in it,
// no "all clear" banner, no invented placeholder row, so an admin never sees
// this page dominated by a section that has nothing to say.
//
// Single-field orderBy(lastSeenAt) only (no equality filter on resolvedAt):
// combining an equality filter with an orderBy on a different field needs
// its own composite index, which doesn't exist for this collection and this
// task is web-only (no backend/index changes). Fetching the most recently
// active 100 and filtering resolvedAt==null client-side is the same
// bounded-no-new-index shape TracksQueue/GigsAdmin already use above.
function AdminAlerts() {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "adminAlerts"), orderBy("lastSeenAt", "desc"), limit(100)),
      (s) => setAlerts(
        s.docs.map((d) => ({ id: d.id, ...(d.data() as AdminAlertDoc) })).filter((a) => a.resolvedAt == null),
      ),
    );
  }, []);
  if (alerts.length === 0) return null;
  return (
    <section className="grid gap-3 rounded-gk border border-gk-warning/40 bg-gk-warning/[0.06] p-4">
      <h2 className="flex items-center gap-2 font-syne text-lg font-semibold text-gk-text">
        <IconWarning size={18} className="text-gk-warning" aria-hidden="true" />
        Needs a human ({alerts.length})
      </h2>
      <div className="grid gap-2">
        {alerts.map((a) => <AdminAlertRow key={a.id} a={a} />)}
      </div>
    </section>
  );
}

export default function AdminPage() {
  return (
    <AdminGate>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Admin</h1>
        <p className="mt-2 font-sora text-sm text-gk-muted">Review queue, moderation, and account tools.</p>
        <div className="mt-8 grid gap-10">
          <AdminAlerts />
          <Queue />
          <TracksQueue />
          <GigsAdmin />
          <TakedownsPanel />
          <UserLookup />
          <AuditLog />
        </div>
      </main>
    </AdminGate>
  );
}
