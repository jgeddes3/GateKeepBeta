"use client";
import { useEffect, useState } from "react";
import {
  collection, doc, getDoc, getDocs, onSnapshot, orderBy, query, where,
} from "firebase/firestore";
import type { EventAct, EventDoc, GigDoc, ProfileDoc, TicketTierDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { formatGigTime } from "../../app/u/[handle]/gigDisplay";
import { EVENT_STATUS_LABEL, EVENT_STATUS_BADGE, formatEventFullDate } from "./eventDisplay";
import { usePosterUrl } from "./posterUrl";
import {
  EventEditor, tierRowFrom, type EventEditorMode, type EventRow, type EventSourceInput, type TierRowState,
} from "./EventEditor";
import { AttendeeList } from "./AttendeeList";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import { PhotoPlaceholder } from "../components/GigCard";
import { IconEvents, IconPlus, IconTicket, IconWarning } from "../ui/icons";

// Sub-project 6 task 10 (brief anatomy: "EventsManager: list (poster thumb,
// title, date, status StatusBadge tone map), per-tier sold/capacity bars,
// create standalone + 'promote a filled gig' (picker over the curator's
// filled gigs without an event), publish + cancel"). One instance per
// curator profile the signed-in account belongs to (app/dashboard/events/
// page.tsx renders one per profile, same "one component per profile the
// caller owns" shape app/dashboard/earnings/page.tsx's own EarningsPanel
// already establishes).

type GigRow = { id: string } & GigDoc;

// A local view state machine, not a nested route (the brief's own Files:
// list names exactly one page.tsx for this whole surface): "list" is the
// default; "picker" is the gig-promotion step; "create" covers both
// standalone and promoted-gig creation (EventEditor's own create mode);
// "manage" is a single event's full editor + attendee roster.
type View =
  | { kind: "list" }
  | { kind: "picker" }
  | { kind: "create"; source: EventSourceInput; seedTitle?: string; seedStartsAt?: number; seedLineup?: EventAct[] }
  | { kind: "manage"; eventId: string };

// Live per-event tier read for the list row's own sold/capacity bars
// (brief anatomy, verbatim): independent of EventEditor's own tier EDITING
// buffer (which seeds once and never re-syncs, see that file's own
// TierEditor comment): this one is read-only and always fresh, exactly
// what a list overview needs.
function TierBars({ eventId }: { eventId: string }) {
  const [tiers, setTiers] = useState<({ id: string } & TicketTierDoc)[] | "loading">("loading");
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(query(collection(db, `events/${eventId}/tiers`), orderBy("sortOrder")),
      (snap) => setTiers(snap.docs.map((d) => ({ id: d.id, ...(d.data() as TicketTierDoc) }))));
  }, [eventId]);
  if (tiers === "loading" || tiers.length === 0) return null;
  return (
    <div className="mt-2 grid gap-1">
      {tiers.map((t) => {
        const pct = t.capacity > 0 ? Math.min(100, Math.round((t.soldCount / t.capacity) * 100)) : 0;
        return (
          <div key={t.id} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate font-sora text-xs text-gk-muted">{t.name}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gk-border/50">
              <div className="h-full rounded-full bg-gk-accent" style={{ width: `${pct}%` }} />
            </div>
            <span className="w-16 shrink-0 text-right font-sora text-xs text-gk-muted">{t.soldCount}/{t.capacity}</span>
          </div>
        );
      })}
    </div>
  );
}

function EventListRow({ event, onManage }: { event: EventRow; onManage: () => void }) {
  const posterUrl = usePosterUrl(event.posterPath);
  return (
    <button
      type="button" onClick={onManage}
      className="flex w-full items-start gap-3.5 rounded-gk border border-gk-border bg-gk-surface p-3.5 text-left outline-none transition-colors hover:border-gk-accent/50 focus-visible:ring-2 focus-visible:ring-gk-focus"
    >
      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-gk-sm border border-gk-border bg-gk-surface">
        {posterUrl ? (
          <img src={posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <PhotoPlaceholder icon={<IconTicket size={18} aria-hidden="true" />} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-syne text-sm font-semibold text-gk-text">{event.title || "Untitled event"}</p>
          <Badge variant={EVENT_STATUS_BADGE[event.status]}>{EVENT_STATUS_LABEL[event.status]}</Badge>
        </div>
        <p className="mt-0.5 font-sora text-sm text-gk-muted">
          {formatEventFullDate(event.startsAt)} · {formatGigTime(event.startsAt)}
        </p>
        <TierBars eventId={event.id} />
      </div>
    </button>
  );
}

function GigPromotePicker({ gigs, onPick, onClose }: { gigs: GigRow[]; onPick: (gig: GigRow) => void; onClose: () => void }) {
  return (
    <div className="grid gap-3">
      <h2 className="font-syne text-lg font-semibold text-gk-text">Promote a filled gig</h2>
      {gigs.length === 0 ? (
        <p className="font-sora text-sm text-gk-muted">
          No filled gigs are available to promote. A gig needs a confirmed act before it can become a ticketed event.
        </p>
      ) : (
        <ul className="grid gap-2">
          {gigs.map((g) => (
            <li key={g.id}>
              <button
                type="button" onClick={() => onPick(g)}
                className="flex w-full items-center justify-between gap-3 rounded-gk border border-gk-border bg-gk-surface px-4 py-3 text-left outline-none transition-colors hover:border-gk-accent/50 focus-visible:ring-2 focus-visible:ring-gk-focus"
              >
                <div className="min-w-0">
                  <p className="truncate font-syne text-sm font-semibold text-gk-text">{g.title || "Untitled gig"}</p>
                  <p className="font-sora text-sm text-gk-muted">{formatEventFullDate(g.startsAt)} · {formatGigTime(g.startsAt)}</p>
                </div>
                <span className="shrink-0 font-sora text-sm text-gk-text underline underline-offset-4">Promote</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant="secondary" onClick={onClose} className="w-fit">Back</Button>
    </div>
  );
}

export function EventsManager({ profileId, name }: { profileId: string; name: string }) {
  const [profile, setProfile] = useState<ProfileDoc | null | "loading">("loading");
  const [events, setEvents] = useState<EventRow[] | "loading">("loading");
  const [gigs, setGigs] = useState<GigRow[]>([]);
  const [view, setView] = useState<View>({ kind: "list" });
  const [manageTiers, setManageTiers] = useState<TierRowState[] | "loading">("loading");

  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", profileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null),
      () => setProfile(null));
  }, [profileId]);
  // where(curatorProfileId=='X') with no status filter: rules-provable for a
  // member via the isMember disjunct alone (firestore.rules' events read
  // rule), same shape gigs/page.tsx's own curator-dashboard query already
  // proves for gigs, and every status comes back in one listener.
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(query(collection(db, "events"), where("curatorProfileId", "==", profileId)),
      (snap) => setEvents(snap.docs.map((d) => ({ id: d.id, ...(d.data() as EventDoc) }))));
  }, [profileId]);
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(query(collection(db, "gigs"), where("curatorProfileId", "==", profileId), where("status", "==", "filled")),
      (snap) => setGigs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) }))));
  }, [profileId]);

  // Loading a specific event's tier rows for EventEditor's create-once
  // buffer (see TierEditor's own header comment on why this is a one-shot
  // read, not a subscription): re-fetched every time `view` newly points at
  // "manage" for a different eventId.
  //
  // The reset to "loading" happens synchronously HERE, during render (React's
  // documented "adjust state while rendering" pattern, same idiom
  // app/dashboard/curator/[profileId]/gigs/[gigId]/page.tsx's own
  // `privLocGigId` uses for an identical "one-shot read keyed off a value
  // that can change without remounting" shape), not inside the effect body
  // below: eslint-config-next's react-hooks/set-state-in-effect rule flags a
  // synchronous setState call in an effect, and calling it here instead
  // means the "loading" state is visible on the SAME render `view` changed,
  // rather than one render late.
  const manageEventId = view.kind === "manage" ? view.eventId : null;
  const [tiersEventId, setTiersEventId] = useState<string | null>(null);
  if (manageEventId !== tiersEventId) {
    setTiersEventId(manageEventId);
    setManageTiers("loading");
  }
  useEffect(() => {
    if (manageEventId == null) return;
    let cancelled = false;
    const { db } = getFirebase();
    getDocs(query(collection(db, `events/${manageEventId}/tiers`), orderBy("sortOrder")))
      .then((snap) => { if (!cancelled) setManageTiers(snap.docs.map((d) => tierRowFrom(d.id, d.data() as TicketTierDoc))); })
      .catch((e) => { console.error("EventsManager: tier load failed", manageEventId, e); if (!cancelled) setManageTiers([]); });
    return () => { cancelled = true; };
  }, [manageEventId]);

  if (profile === "loading" || events === "loading") {
    return (
      <div className="grid gap-3" role="status" aria-label={`Loading ${name}'s events`}>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }
  if (!profile) return null;

  const isVenue = profile.subtype === "venue";
  const curatorAddress = profile.curator?.location?.address ?? null;
  const usedGigIds = new Set(events.filter((e) => e.gigId).map((e) => e.gigId));
  const eligibleGigs = gigs.filter((g) => !usedGigIds.has(g.id));

  const promoteGig = async (gig: GigRow) => {
    let seedLineup: EventAct[] = [];
    if (gig.bookingId && gig.bookedMusicianProfileId) {
      try {
        const snap = await getDoc(doc(getFirebase().db, "profiles", gig.bookedMusicianProfileId));
        const actName = snap.exists() ? (snap.data() as ProfileDoc).name : gig.title;
        seedLineup = [{ kind: "booking", bookingId: gig.bookingId, musicianProfileId: gig.bookedMusicianProfileId, name: actName }];
      } catch (e) {
        console.warn("EventsManager: booked-act name lookup failed, promoting without a seeded lineup", gig.id, e);
      }
    }
    setView({
      kind: "create", source: { kind: "gig", gigId: gig.id },
      seedTitle: gig.title, seedStartsAt: gig.startsAt, seedLineup,
    });
  };

  if (view.kind === "picker") {
    return (
      <div className="rounded-gk border border-gk-border bg-gk-surface p-5">
        <GigPromotePicker gigs={eligibleGigs} onPick={promoteGig} onClose={() => setView({ kind: "list" })} />
      </div>
    );
  }

  if (view.kind === "create") {
    return (
      <div className="rounded-gk border border-gk-border bg-gk-surface p-5">
        <EventEditor
          profileId={profileId} isVenue={isVenue} curatorAddress={curatorAddress}
          mode={{ kind: "create", source: view.source, seedTitle: view.seedTitle, seedStartsAt: view.seedStartsAt, seedLineup: view.seedLineup }}
          onClose={() => setView({ kind: "list" })}
          onCreated={(eventId) => setView({ kind: "manage", eventId })}
          onCancelled={() => setView({ kind: "list" })}
        />
      </div>
    );
  }

  if (view.kind === "manage") {
    const event = events.find((e) => e.id === view.eventId);
    if (!event) {
      return (
        <div className="rounded-gk border border-gk-border bg-gk-surface p-5">
          <p className="font-sora text-sm text-gk-muted">This event could not be found.</p>
          <Button type="button" variant="secondary" onClick={() => setView({ kind: "list" })} className="mt-3">Back to events</Button>
        </div>
      );
    }
    return (
      <div className="grid gap-6">
        <div className="rounded-gk border border-gk-border bg-gk-surface p-5">
          {manageTiers === "loading" ? (
            <div className="grid gap-3" role="status" aria-label="Loading event">
              <Skeleton className="h-8 w-64" /><Skeleton className="h-32 w-full" />
            </div>
          ) : (
            <EventEditor
              profileId={profileId} isVenue={isVenue} curatorAddress={curatorAddress}
              mode={{ kind: "edit", event, initialTiers: manageTiers } satisfies EventEditorMode}
              onClose={() => setView({ kind: "list" })}
              onCreated={() => {}}
              onCancelled={() => {}}
            />
          )}
        </div>
        <div className="rounded-gk border border-gk-border bg-gk-surface p-5">
          <h3 className="font-syne text-lg font-semibold text-gk-text">Attendees</h3>
          <div className="mt-3">
            <AttendeeList curatorProfileId={profileId} eventId={event.id} eventStatus={event.status} eventEndsAt={event.endsAt} />
          </div>
        </div>
      </div>
    );
  }

  // "list" (default)
  const active = events.filter((e) => e.status === "draft" || e.status === "published")
    .sort((a, b) => a.startsAt - b.startsAt);
  const past = events.filter((e) => e.status === "completed" || e.status === "cancelled")
    .sort((a, b) => b.startsAt - a.startsAt);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-syne text-xl font-bold text-gk-text">{name}</h2>
        {profile.status === "approved" ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => setView({ kind: "create", source: { kind: "standalone" } })}>
              <IconPlus size={16} aria-hidden="true" />
              New event
            </Button>
            <Button type="button" variant="secondary" onClick={() => setView({ kind: "picker" })}>
              Promote a gig
            </Button>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 font-sora text-sm text-gk-muted">
            <IconWarning size={14} aria-hidden="true" />
            Your curator profile must be approved before you can create events.
          </p>
        )}
      </div>

      {active.length === 0 && past.length === 0 ? (
        <div className="rounded-gk border border-gk-border bg-gk-surface px-6 py-10 text-center">
          <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
            <IconEvents size={20} aria-hidden="true" />
          </span>
          <p className="mt-3 font-syne text-base font-semibold text-gk-text">No events yet</p>
          <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
            Create a standalone ticketed event, or promote a gig you&apos;ve already booked.
          </p>
        </div>
      ) : (
        <>
          {active.length > 0 && (
            <section className="grid gap-2">
              <h3 className="font-syne text-sm font-semibold uppercase tracking-wide text-gk-muted">Active ({active.length})</h3>
              <div className="grid gap-2">
                {active.map((e) => <EventListRow key={e.id} event={e} onManage={() => setView({ kind: "manage", eventId: e.id })} />)}
              </div>
            </section>
          )}
          {past.length > 0 && (
            <section className="grid gap-2">
              <h3 className="font-syne text-sm font-semibold uppercase tracking-wide text-gk-muted">Past &amp; cancelled ({past.length})</h3>
              <div className="grid gap-2">
                {past.map((e) => <EventListRow key={e.id} event={e} onManage={() => setView({ kind: "manage", eventId: e.id })} />)}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
