"use client";
import { useEffect, useState, useRef } from "react";
import {
  collection, collectionGroup, query, where, onSnapshot, orderBy, limit, getDoc, getDocs, doc,
  type DocumentReference,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getDownloadURL, ref as storageRef } from "firebase/storage";
import { getFirebase } from "../../src/lib/firebase";
import { AdminGate } from "./AdminGate";
import { GIG_STATUS_LABEL, formatGigDateTime, badge } from "../../src/gigs/GigForms";
import {
  GIG_STATUSES,
  type ProfileDoc, type AuditLogDoc, type UserDoc, type TrackDoc, type GigDoc, type GigStatus,
  type CuratorSubtype, type AdminNoteDoc,
} from "@gatekeep/shared";

type Row<T> = T & { id: string };

// Resolves one public/photos/... path to a displayable thumbnail URL — same
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
  if (url === "error") return <p style={{ color: "#b00020", fontSize: 12, margin: 0 }}>{alt} unavailable</p>;
  if (!url) return <p style={{ color: "#888", fontSize: 12, margin: 0 }}>{alt} loading…</p>;
  return <img src={url} alt={alt} style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 4, border: "1px solid #ccc" }} />;
}

// Resolves the uid of the profile's owner — the member whose role is
// "admin" who joined earliest (createProfileDraft always writes exactly one
// such member, {uid, role:"admin", label:"owner"}, at creation time;
// inviteMember can add further admin-role members later, so "earliest
// joinedAt" rather than "the only admin" picks the original creator when
// more than one exists). Used by QueueRow's reject-with-flag below to know
// WHO flagAccount's uid should target, since ProfileDoc itself carries no
// owner-uid field. Fetches the whole (small, single-digit) members
// subcollection rather than an equality+orderBy query, deliberately: that
// combination needs its own composite index, which doesn't exist (and this
// task is web-only — no backend/index changes), so sorting client-side over
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

// Owns the Approve/Reject actions (and their in-flight/error state) for
// exactly one queue row. A per-row component — rather than a shared
// in-flight-ids array on Queue — keeps the busy flag local state instead of
// a setState update derived from an effect, matching the keyed-component
// reset pattern used elsewhere in this app (dashboard's ProfilesList,
// AdminGate's ClaimCheck).
//
// Finding 2: reviewers were approving bio/photos/genres/links sight-unseen —
// the checklist below said "check submitted details for impersonation" but
// nothing on this row showed those details. Musician portfolios show their
// portfolio block; curator profiles (Task 12) show the curator gate-fields
// block below instead — each type only has one of the two.
//
// Task 12 also adds an optional "also flag this account" checkbox+note next
// to Reject: when checked, flagAccount is called AFTER reviewProfile's
// reject commits (never before — a flag on an account whose reject then
// fails would leave a flag with nothing to explain it). Both calls share
// this row's one `busy` lock, so nothing else on the row can fire mid
// two-step sequence.
function QueueRow({ p }: { p: Row<ProfileDoc> }) {
  const [busy, setBusy] = useState(false);
  const [flagChecked, setFlagChecked] = useState(false);
  const [flagNote, setFlagNote] = useState("");
  const review = async (decision: "approved" | "rejected") => {
    const reason = decision === "rejected"
      ? window.prompt("Rejection reason (shown to the applicant):") ?? "" : undefined;
    if (decision === "rejected" && !reason) return;
    const trimmedFlagNote = flagNote.trim();
    if (decision === "rejected" && flagChecked && (trimmedFlagNote.length < 1 || trimmedFlagNote.length > 500)) {
      window.alert('Enter a note (1-500 characters) for "also flag this account", or uncheck it.');
      return;
    }
    setBusy(true);
    try {
      const { functions } = getFirebase();
      await httpsCallable(functions, "reviewProfile")({ profileId: p.id, decision, reason });
      if (decision === "rejected" && flagChecked) {
        try {
          const ownerUid = await resolveProfileOwnerUid(p.id);
          if (!ownerUid) throw new Error("Could not find an account on this profile to flag.");
          await httpsCallable(functions, "flagAccount")({ uid: ownerUid, text: trimmedFlagNote });
          setFlagChecked(false);
          setFlagNote("");
        } catch (flagError) {
          window.alert(
            `The review was submitted, but the account flag failed: ${
              flagError instanceof Error ? flagError.message : "try flagging from User lookup instead."
            }`,
          );
        }
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not submit the review — try again.");
    } finally {
      setBusy(false);
    }
  };
  const pf = p.type === "musician" ? p.portfolio : undefined;
  const curator = p.type === "curator" ? p.curator : undefined;
  // Same https-only display filter as the public /u/[handle] page and the
  // mobile artist screen — belt-and-suspenders even though
  // validatePortfolioUpdate already enforces this at write time.
  const links = (pf?.externalLinks ?? []).filter((l) => l.url.startsWith("https://"));
  return (
    <div style={{ border: "1px solid #ddd", padding: 12, marginBottom: 8 }}>
      <strong>{p.name}</strong> @{p.handle} — {p.type} ({p.subtype})
      {typeof p.resubmitCount === "number" && p.resubmitCount > 0 && (
        <>{" "}<span style={badge("#fde68a")}>resubmitted ×{p.resubmitCount}</span></>
      )}
      {curator && (
        <div style={{ marginTop: 8, fontSize: 14 }}>
          <p style={{ margin: "0 0 4px" }}>
            {curator.photoPaths.length} photo{curator.photoPaths.length === 1 ? "" : "s"}
            {" · "}{curator.location.address ?? curator.location.city}
          </p>
          {curator.lookingFor.genres.length > 0 && (
            <p style={{ margin: "0 0 4px" }}>Genres: {curator.lookingFor.genres.join(", ")}</p>
          )}
          {curator.lookingFor.actSizes.length > 0 && (
            <p style={{ margin: "0 0 4px" }}>Act sizes: {curator.lookingFor.actSizes.join(", ")}</p>
          )}
          {curator.about && (
            <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>
              {curator.about.length > 240 ? `${curator.about.slice(0, 240)}…` : curator.about}
            </p>
          )}
          {!curator.about && curator.lookingFor.genres.length === 0 && curator.lookingFor.actSizes.length === 0
            && curator.photoPaths.length === 0 && (
            <p style={{ margin: 0, color: "#888" }}>No curator details submitted.</p>
          )}
        </div>
      )}
      {pf && (
        <div style={{ marginTop: 8, display: "flex", gap: 12 }}>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <PhotoThumb path={pf.avatarPhotoPath} alt="Avatar" />
            <PhotoThumb path={pf.coverPhotoPath} alt="Cover" />
          </div>
          <div style={{ fontSize: 14, minWidth: 0 }}>
            {pf.genres.length > 0 && <p style={{ margin: "0 0 4px" }}>{pf.genres.join(" · ")}</p>}
            {pf.bio && <p style={{ margin: "0 0 4px", whiteSpace: "pre-wrap" }}>{pf.bio}</p>}
            {links.length > 0 && (
              <p style={{ margin: 0 }}>
                {links.map((l) => (
                  <a key={`${l.kind}:${l.url}`} href={l.url} target="_blank" rel="noopener noreferrer nofollow"
                    style={{ marginRight: 8 }}>
                    {l.kind}
                  </a>
                ))}
              </p>
            )}
            {!pf.bio && pf.genres.length === 0 && links.length === 0 && !pf.avatarPhotoPath && !pf.coverPhotoPath && (
              <p style={{ margin: 0, color: "#888" }}>No portfolio content submitted.</p>
            )}
          </div>
        </div>
      )}
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button disabled={busy} onClick={() => review("approved")}>Approve</button>{" "}
        <button disabled={busy} onClick={() => review("rejected")}>Reject…</button>
        <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}
          title="Only takes effect when you click Reject — checking this has no effect on Approve.">
          <input
            type="checkbox"
            disabled={busy}
            checked={flagChecked}
            onChange={(e) => setFlagChecked(e.target.checked)}
          />
          also flag this account (Reject only)
        </label>
        {flagChecked && (
          <input
            placeholder="flag note (shown only to admins)"
            value={flagNote}
            disabled={busy}
            maxLength={500}
            onChange={(e) => setFlagNote(e.target.value)}
            style={{ fontSize: 13, flex: "1 1 220px", minWidth: 160 }}
          />
        )}
      </div>
    </div>
  );
}

function Queue() {
  const [pending, setPending] = useState<Row<ProfileDoc>[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "profiles"), where("status", "==", "pending_review")),
      (s) => setPending(s.docs.map((d) => ({ id: d.id, ...(d.data() as ProfileDoc) }))),
    );
  }, []);
  return (
    <section>
      <h2>Approvals queue ({pending.length})</h2>
      {/* Review checklist per spec §6: shown to the reviewing admin, not just a code comment. */}
      <p style={{ background: "#fff8e1", border: "1px solid #f0d878", padding: "8px 12px", borderRadius: 4 }}>
        Before approving: verify this is really them — check the name, handle, and submitted
        details for impersonation.
      </p>
      {pending.map((p) => <QueueRow key={p.id} p={p} />)}
      {pending.length === 0 && <p>Nothing waiting.</p>}
    </section>
  );
}

type TrackRow = Row<TrackDoc> & { profileId: string; profileName: string };

// Owns the Approve/Reject actions for exactly one pending track — same
// per-row-busy-state rationale as QueueRow above. Also resolves and plays the
// review clip inline (spec §6: admin listens before approving), via
// getDownloadURL on the track's review/... storagePath — admins can read any
// review clip under storage.rules. url is three-state: null while resolving
// (loading placeholder), "error" if getDownloadURL rejects (e.g. the object
// is missing — surfaced as an explicit dead-end rather than an infinite
// "clip loading…", since nothing will ever move it out of that state), or
// the resolved string. storagePath is typed nullable on TrackDoc (other
// statuses can have no file yet); the transcode trigger only ever writes
// status:"pending_review" and storagePath together in the same update, so in
// practice every row here has one, but the effect still guards against a
// falsy path rather than assuming that invariant.
function TrackQueueRow({ t }: { t: TrackRow }) {
  const [busy, setBusy] = useState(false);
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
  const review = async (decision: "approved" | "rejected") => {
    const reason = decision === "rejected"
      ? window.prompt("Rejection reason (shown to the musician):") ?? "" : undefined;
    if (decision === "rejected" && !reason) return;
    setBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "reviewTrack")(
        { profileId: t.profileId, trackId: t.id, decision, reason });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not submit the review — try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ border: "1px solid #ddd", padding: 12, marginBottom: 8 }}>
      <strong>{t.title}</strong> — {t.profileName} · {t.durationSec ?? "?"}s
      {t.storagePath == null
        ? <p style={{ color: "#888" }}>No clip on file.</p>
        : url === "error"
          ? <p style={{ color: "#b00020" }}>Clip unavailable — reject and ask the musician to re-upload.</p>
          : url
            ? <audio controls preload="none" src={url} style={{ display: "block", margin: "8px 0" }} />
            : <p style={{ color: "#888" }}>clip loading…</p>}
      <button disabled={busy} onClick={() => review("approved")}>Approve</button>{" "}
      <button disabled={busy} onClick={() => review("rejected")}>Reject…</button>
    </div>
  );
}

// Pending-track review queue (spec §6). collectionGroup('tracks') mirrors
// Queue's flat collection query above, but tracks live under
// profiles/{profileId}/tracks — collectionGroup + the admin CG-read rule and
// fieldOverride index (already in place) is what makes a single
// cross-profile "everything pending" listener possible. Bounded with
// limit(100), same reasoning as AuditLog's limit(50): an admin listener
// should never fan out unboundedly. This intentionally doesn't order by
// createdAt (i.e. isn't FIFO-oldest-first) — collectionGroup + an equality
// filter + orderBy on a different field needs its own composite index,
// which doesn't exist yet; deferred until the queue realistically nears
// this cap and ordering starts to matter.
//
// Each snapshot also resolves the parent profile doc for its name
// (deleted-profile-safe, same "(deleted)" fallback the mobile/web
// dashboards use elsewhere) — batched via Promise.all over the *unique*
// profile ids in this snapshot (several pending tracks routinely share a
// profile), not one sequential getDoc per track. Two race guards on top of
// that N+1 resolution, since it's async work hanging off a listener that
// can fire again before it finishes: `cancelled` (composed into the
// cleanup, same convention as UserProfiles below) for unmount, and a
// monotonic `seq` token so a slower, older snapshot's resolution can never
// finish after and repaint over a newer one's already-committed state.
function TracksQueue() {
  const [pending, setPending] = useState<TrackRow[]>([]);
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
      },
    );
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  return (
    <section>
      <h2>Track review queue ({pending.length})</h2>
      {/* Screening guidance per spec §6: admins hear exactly what the public would. */}
      <p style={{ background: "#fff8e1", border: "1px solid #f0d878", padding: "8px 12px", borderRadius: 4 }}>
        You are hearing exactly what the public would hear. Screening call: does this
        sound like the artist&apos;s own performance (not AI-generated / not someone
        else&apos;s recording)? When unsure, reject with a note asking for context.
      </p>
      {pending.map((t) => <TrackQueueRow key={`${t.profileId}-${t.id}`} t={t} />)}
      {pending.length === 0 && <p>Nothing waiting.</p>}
    </section>
  );
}

const NON_VENUE_SUBTYPES = new Set<CuratorSubtype>(["planner", "individual_host"]);

// Task 12's admin gig-moderation section. Mirrors GigsList's own STATUS_BG/
// STATUS_FG palette (apps/web/app/dashboard/curator/[profileId]/gigs/
// page.tsx) rather than importing it — that file only exports the map
// implicitly via a module-private const, not through GigForms.tsx's shared
// exports, so duplicating a 5-entry Record here is simpler than widening
// that page's own export surface for one reuse.
const GIG_STATUS_BG: Record<GigDoc["status"], string> = {
  draft: "#fef9c3", open: "#dcfce7", closed: "#e5e7eb", cancelled: "#fee2e2", taken_down: "#fed7aa",
};
const GIG_STATUS_FG: Partial<Record<GigDoc["status"], string>> = { taken_down: "#9a3412" };

type GigModRow = Row<GigDoc> & {
  curatorName: string; curatorHandle: string | null; curatorSubtype: CuratorSubtype | null;
};

// Owns the takedown action (and its busy/error state) for exactly one gig
// row — same per-row-component rationale as QueueRow/TrackQueueRow above.
// Series occurrences get a choice of scope (backend's takedownGig requires
// scope:"series" to actually own a seriesId, so the series button is simply
// absent otherwise rather than being shown-then-rejected); a standalone gig
// only ever gets the one "this date" button.
function GigModerationRow({ g }: { g: GigModRow }) {
  const [busy, setBusy] = useState(false);
  const takedown = async (scope: "occurrence" | "series") => {
    const reason = window.prompt(
      scope === "series"
        ? "Takedown reason (shown to the curator) — this removes this date AND every other open date in the series, and pauses the series:"
        : "Takedown reason (shown to the curator) — this removes this date immediately:",
    ) ?? "";
    if (!reason.trim()) return;
    if (reason.trim().length > 500) { window.alert("Reason must be 500 characters or fewer."); return; }
    setBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "takedownGig")({ gigId: g.id, scope, reason: reason.trim() });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not take down the gig — try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ border: "1px solid #ddd", padding: 12, marginBottom: 8 }}>
      <strong>{g.title || "Untitled gig"}</strong>{" "}
      <span style={badge(GIG_STATUS_BG[g.status], GIG_STATUS_FG[g.status])}>{GIG_STATUS_LABEL[g.status]}</span>
      <p style={{ margin: "4px 0 0", fontSize: 14, color: "#666" }}>
        {g.curatorHandle
          ? <a href={`/u/${g.curatorHandle}`} target="_blank" rel="noopener noreferrer">{g.curatorName}</a>
          : g.curatorName}
        {" · "}{formatGigDateTime(g.startsAt)}
      </p>
      {g.status !== "taken_down" && (
        <div style={{ marginTop: 8 }}>
          <button disabled={busy} onClick={() => takedown("occurrence")}>
            {busy ? "Taking down…" : "Take down this date…"}
          </button>{" "}
          {g.seriesId && (
            <button disabled={busy} onClick={() => takedown("series")}>
              {busy ? "Taking down…" : "Take down entire series…"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Status filter (default "open" — the actionable moderation queue; other
// statuses are there for the "did I already handle this" / "what happened
// to it" lookback) + subtype toggle (default non-venue — spec's trust
// split: individually-run planner/host gigs get eyes-on moderation, venue
// gigs default OFF the list since venues clear an address-verification bar
// venues-only at approval time (see profiles.ts's hasLocation check) that
// planners/hosts don't).
//
// GigDoc carries no subtype of its own (only curatorProfileId) — the
// admin-readable gigs query is by status alone, and curator subtype comes
// from a second, batched read: same N+1-avoidance shape as TracksQueue's
// profile-name resolution above (Promise.all over the *unique*
// curatorProfileIds in the current snapshot), just carrying subtype+handle
// alongside name instead of name alone. Same two race guards too
// (`cancelled` for unmount, monotonic `seq` so a slower/older snapshot's
// resolution can't finish after and repaint over a newer one).
function GigsAdmin() {
  const [status, setStatus] = useState<GigStatus>("open");
  const [showVenue, setShowVenue] = useState(false);
  const [rows, setRows] = useState<GigModRow[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    let cancelled = false;
    let seq = 0;
    const unsubscribe = onSnapshot(
      query(collection(db, "gigs"), where("status", "==", status)),
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
      },
    );
    return () => { cancelled = true; unsubscribe(); };
  }, [status]);

  const filtered = rows.filter((g) => (
    showVenue ? g.curatorSubtype === "venue" : g.curatorSubtype === null || NON_VENUE_SUBTYPES.has(g.curatorSubtype)
  ));

  return (
    <section>
      <h2>Gigs ({filtered.length})</h2>
      <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 8 }}>
        <label style={{ fontSize: 14 }}>
          Status:{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value as GigStatus)}>
            {GIG_STATUSES.map((s) => <option key={s} value={s}>{GIG_STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 14 }}>
          <input type="checkbox" checked={showVenue} onChange={(e) => setShowVenue(e.target.checked)} />
          {" "}Show venue gigs (default: planners &amp; individual hosts only)
        </label>
      </div>
      {filtered.map((g) => <GigModerationRow key={g.id} g={g} />)}
      {filtered.length === 0 && <p>Nothing here.</p>}
    </section>
  );
}

// Retroactive-takedown panel (spec §6: "admins can retroactively unpublish").
// reviewTrack already accepts decision:"rejected" against an already-approved
// track — TracksQueue above can't reach that path since it only ever lists
// pending_review tracks, so this gives admins a way in: look a profile up by
// handle, see its live (approved) tracks, remove one with a reason. Same
// handles/{handle} -> profileId indirection the public /u/[handle] route
// uses, and handles are stored lowercase there too.
function TakedownsPanel() {
  const [handle, setHandle] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profile, setProfile] = useState<Row<ProfileDoc> | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [tracks, setTracks] = useState<Row<TrackDoc>[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Track ids whose most recent removal attempt committed the reject
  // server-side but then hit reviewTrack's "unavailable" (public clip
  // couldn't be deleted) — see the remove() catch below for why these stay
  // in `tracks` and get a visible marker instead of disappearing.
  const [incompleteIds, setIncompleteIds] = useState<Set<string>>(new Set());
  // Guards lookup() the same way TracksQueue's `seq` guards its snapshot
  // handler: the Enter-key handler and the Look-up button both call
  // lookup(), and disabling on lookupBusy narrows but doesn't fully close
  // the window for a second call to start before React commits the first's
  // setLookupBusy(true) (both can read the same stale closure mid-event). A
  // ref (not state — needs to be readable synchronously the instant a
  // response resolves) means a slower, superseded lookup's response can
  // never overwrite a newer one's already-displayed results.
  const lookupSeq = useRef(0);

  const lookup = async () => {
    const h = handle.trim().toLowerCase();
    if (!h) return;
    const mySeq = ++lookupSeq.current;
    setLookupBusy(true);
    // Clear any previous handle's results up front, so a failed lookup (or a
    // slow one) never leaves a stale profile's tracks on screen under a new
    // handle in the input.
    setProfileId(null);
    setProfile(null);
    setTracks([]);
    setIncompleteIds(new Set());
    try {
      const { db } = getFirebase();
      const handleDoc = await getDoc(doc(db, "handles", h));
      if (mySeq !== lookupSeq.current) return; // superseded by a newer lookup
      if (!handleDoc.exists()) { window.alert("No profile with that handle."); return; }
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
        window.alert(e instanceof Error ? e.message : "Could not look up that handle — try again.");
      }
    } finally {
      if (mySeq === lookupSeq.current) setLookupBusy(false);
    }
  };

  // Retroactive profile unpublish (spec §6, item C): reviewProfile's reject
  // decision now also accepts an already-approved profile — flipping it to
  // rejected hides the profile AND all its tracks from public reads via
  // firestore.rules' profileApproved() gate, without needing to take down
  // each track individually first.
  const unpublishProfile = async () => {
    if (!profileId) return;
    const reason = window.prompt(
      "Unpublish reason (shown to the profile's admins) — this removes the profile, and everything on it, from public immediately:",
    ) ?? "";
    if (!reason) return;
    if (reason.length > 500) { window.alert("Reason must be 500 characters or fewer."); return; }
    setProfileBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "reviewProfile")(
        { profileId, decision: "rejected", reason });
      setProfile((p) => (p ? { ...p, status: "rejected", rejectionReason: reason } : p));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not unpublish the profile — try again.");
    } finally {
      setProfileBusy(false);
    }
  };

  const remove = async (trackId: string) => {
    if (!profileId) return;
    const reason = window.prompt(
      "Takedown reason (shown to the musician) — this removes the track from their live profile immediately:",
    ) ?? "";
    if (!reason) return;
    setBusyId(trackId);
    try {
      await httpsCallable(getFirebase().functions, "reviewTrack")(
        { profileId, trackId, decision: "rejected", reason });
      setTracks((ts) => ts.filter((t) => t.id !== trackId));
      setIncompleteIds((ids) => { const next = new Set(ids); next.delete(trackId); return next; });
    } catch (e) {
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
      if (code === "functions/unavailable") {
        // reviewTrack already committed "rejected" before throwing this —
        // the decision is final at the transaction, storage cleanup runs
        // after (see that function's comments) — so the public object may
        // still be reachable even though the doc says rejected. Don't
        // filter the row out: a fresh lookup queries status=="approved",
        // which this doc no longer matches, so re-looking-up would just
        // silently drop the row and hide an incomplete takedown. Mark it
        // instead, so the admin sees it needs a retry rather than assuming
        // it's still an ordinary live track.
        setIncompleteIds((ids) => new Set(ids).add(trackId));
      } else {
        window.alert(e instanceof Error ? e.message : "Could not remove the track — try again.");
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section>
      <h2>Takedowns</h2>
      <p>Retroactively remove a live profile or track (spec §6).</p>
      <input
        placeholder="@handle"
        value={handle}
        onChange={(e) => setHandle(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !lookupBusy) void lookup(); }}
      />{" "}
      <button disabled={lookupBusy} onClick={lookup}>{lookupBusy ? "Looking up…" : "Look up"}</button>
      {profile && (
        <div style={{ border: "1px solid #ddd", padding: 12, marginTop: 8, background: "#fafafa" }}>
          <strong>{profile.name}</strong> @{profile.handle} — {profile.status.replace("_", " ")}
          {profile.status === "approved" ? (
            <div>
              <button disabled={profileBusy} onClick={unpublishProfile}>
                {profileBusy ? "Unpublishing…" : "Unpublish profile…"}
              </button>
            </div>
          ) : (
            <p style={{ color: "#888", margin: "4px 0 0" }}>Not currently live — nothing to unpublish.</p>
          )}
        </div>
      )}
      {tracks.map((t) => (
        <div key={t.id} style={{ border: "1px solid #ddd", padding: 12, marginTop: 8 }}>
          <strong>{t.title}</strong> · {t.durationSec ?? "?"}s
          {incompleteIds.has(t.id) && (
            <p style={{ color: "#b00020", margin: "4px 0" }}>
              Removal incomplete — retry. (The track is already off review, but the public
              clip may still be reachable.)
            </p>
          )}
          <div>
            <button disabled={busyId === t.id} onClick={() => remove(t.id)}>
              {busyId === t.id ? "Removing…" : incompleteIds.has(t.id) ? "Retry removal…" : "Remove…"}
            </button>
          </div>
        </div>
      ))}
      {profileId && tracks.length === 0 && <p>No approved tracks.</p>}
    </section>
  );
}

// Loads and displays one user's profiles + statuses (spec §6: "profiles and
// statuses"), via the same collectionGroup('members').where('uid', ...)
// pattern the mobile/web dashboards use for "my profiles" — admins can read
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
  if (profiles === "loading") return <p style={{ margin: "4px 0 0 16px", fontSize: 14 }}>Loading profiles…</p>;
  if (profiles.length === 0) return <p style={{ margin: "4px 0 0 16px", fontSize: 14 }}>No profiles.</p>;
  return (
    <ul style={{ margin: "4px 0 0 16px", fontSize: 14 }}>
      {profiles.map((p) => <li key={p.id}>{p.name} — {p.type} — {p.status.replace("_", " ")}</li>)}
    </ul>
  );
}

// Renders adminNotes/{uid} (Task 12) inline on a user-lookup result —
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
  if (notes === "loading") return <p style={{ margin: "4px 0 0 16px", fontSize: 14, color: "#888" }}>Loading notes…</p>;
  if (notes.length === 0) return null;
  return (
    <ul style={{ margin: "4px 0 0 16px", fontSize: 14, color: "#b00020" }}>
      {notes.map((n) => (
        <li key={`${n.byUid}-${n.at}`}>{new Date(n.at).toLocaleString()} — {n.text}</li>
      ))}
    </ul>
  );
}

type LookupMode = "email" | "name";
type UserResult = { id: string; displayName: string; email: string };

// Task 12: adds a name-prefix mode (searchUsersByName, admin-only callable
// over the displayNameLower index) alongside the original exact-email path,
// via a mode toggle rather than two always-visible inputs — mirrors the
// existing single-input/single-button lookup shape instead of doubling the
// UI surface. Both paths funnel into the same UserResult shape so the
// results list below (profiles + adminNotes) is written once.
//
// `searchSeq` guards search() the same way TakedownsPanel's lookupSeq guards
// its lookup() above: a ref (not state) so a slower, superseded search's
// response can never overwrite a newer one's already-displayed results —
// relevant here specifically because switching mode mid-request or
// double-clicking Search both fire overlapping async calls.
function UserLookup() {
  const [mode, setMode] = useState<LookupMode>("email");
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const searchSeq = useRef(0);

  const switchMode = (m: LookupMode) => {
    if (m === mode) return;
    setMode(m);
    setResults([]);
    setSearched(false);
  };

  const search = async () => {
    const q = term.trim();
    if (!q) return;
    const mySeq = ++searchSeq.current;
    setBusy(true);
    setSearched(true);
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
        window.alert(e instanceof Error ? e.message : "Search failed — try again.");
        setResults([]);
      }
    } finally {
      if (mySeq === searchSeq.current) setBusy(false);
    }
  };

  return (
    <section>
      <h2>User lookup</h2>
      <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
        <label style={{ fontSize: 14 }}>
          <input type="radio" name="lookup-mode" disabled={busy} checked={mode === "email"}
            onChange={() => switchMode("email")} /> Email (exact)
        </label>
        <label style={{ fontSize: 14 }}>
          <input type="radio" name="lookup-mode" disabled={busy} checked={mode === "name"}
            onChange={() => switchMode("name")} /> Name (prefix)
        </label>
      </div>
      <input
        placeholder={mode === "email" ? "exact email" : "name prefix"}
        value={term}
        disabled={busy}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !busy) void search(); }}
      />{" "}
      <button disabled={busy} onClick={search}>{busy ? "Searching…" : "Search"}</button>
      {results.map((u) => (
        <div key={u.id} style={{ marginTop: 8 }}>
          <p style={{ margin: 0 }}>{u.displayName} · {u.email} · uid {u.id}</p>
          <AdminNotes uid={u.id} />
          <UserProfiles key={u.id} uid={u.id} />
        </div>
      ))}
      {searched && !busy && results.length === 0 && <p>No match.</p>}
    </section>
  );
}

function AuditLog() {
  const [logs, setLogs] = useState<Row<AuditLogDoc>[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "auditLogs"), orderBy("at", "desc"), limit(50)),
      (s) => setLogs(s.docs.map((d) => ({ id: d.id, ...(d.data() as AuditLogDoc) }))),
    );
  }, []);
  return (
    <section>
      <h2>Audit log</h2>
      {logs.map((l) => (
        <p key={l.id}>{new Date(l.at).toLocaleString()} — {l.action} — target {l.targetId} — by {l.actorUid} {l.detail && `— ${l.detail}`}</p>
      ))}
      {logs.length === 0 && <p>No activity yet.</p>}
    </section>
  );
}

export default function AdminPage() {
  return (
    <AdminGate>
      <main style={{ maxWidth: 860, margin: "40px auto", display: "grid", gap: 32 }}>
        <h1>GateKeep Admin</h1>
        <Queue /><TracksQueue /><GigsAdmin /><TakedownsPanel /><UserLookup /><AuditLog />
      </main>
    </AdminGate>
  );
}
