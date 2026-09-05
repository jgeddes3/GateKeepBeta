"use client";
import { useState } from "react";
import { collection, getDocs, orderBy, query } from "firebase/firestore";
import {
  AGE_RESTRICTIONS, AGE_RESTRICTION_LABEL, DOORS_MAX_BEFORE_START_MS, EVENT_DOORS_MESSAGE,
  GENRES, type AgeRestriction, type EventAct, type EventDoc, type EventStatus, type TaggedActStatus, type TicketTierDoc,
} from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { LocationFields, MAX_ADDRESS_LENGTH, type LocationValue } from "../gigs/GigForms";
import { EVENT_STATUS_LABEL, EVENT_STATUS_BADGE } from "./eventDisplay";
import { PosterField } from "./PosterField";
import { ArtistPicker } from "./ArtistPicker";
import { Chip, formatChipLabel } from "../portfolio/PortfolioForms";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";
import { IconPlus, IconTrash, IconWarning } from "../ui/icons";

// Sub-project 6 task 10 (brief anatomy: "EventEditor: fields per
// validateEventInput, tier rows (add/remove while draft, capacity-raise
// only after publish, exactly as the callables enforce; surface rejections
// via shared messages)").
//
// apps/web never depends on functions/src types (BuyTicketsFlow.tsx's own
// header documents this boundary): createEvent/updateEvent/setEventTiers'
// real input interfaces live in functions/src/events.ts and are not
// exported to @gatekeep/shared, so the payload shapes below are hand-
// mirrored, same as GigForms.tsx's CreateGigPayload/UpdateGigPayload are
// for createGig/updateGig. Client-side validation here is a light UX-only
// pre-check (matching this codebase's own composer convention, e.g.
// GigForms' inline budget checks): the server (validateEventInput/
// validateTierInput in functions/src/eventsCore.ts) remains the sole
// authority, and every rejection it throws is surfaced verbatim.
//
// SCOPING NOTE (recorded, not a gap owed elsewhere): the lineup editor
// below only lets a curator ADD "external" acts by name. A "booking" act
// (EventAct's other kind, linking a lineup slot to a real confirmed
// booking so it can render as a link on the musician's own public page)
// can only ever get INTO this array from EventsManager's "promote a filled
// gig" flow, which seeds exactly one from the gig's own booked act; this
// editor can display and remove that seeded row, but has no UI to author a
// brand-new booking-linked act by hand. A full musician/booking picker for
// hand-built lineups is a reasonable follow-up, not attempted here: the
// brief's own anatomy names create/tiers/publish/cancel as this task's
// surface, not a booking-linkage picker.

export type EventSourceInput =
  | { kind: "standalone"; location?: { address?: string | null; addressVisibility?: "public" | "neighborhood" } }
  | { kind: "gig"; gigId: string };

interface CreateEventPayload {
  curatorProfileId: string; source: EventSourceInput;
  title: string; description: string; startsAt: number; endsAt: number;
  maxTicketsPerBuyer?: number; lineup: EventAct[]; posterPath?: string | null;
  curatorGenres?: string[]; doorsAt: number | null; ageRestriction: AgeRestriction;
}
interface UpdateEventPayload {
  curatorProfileId: string; eventId: string;
  title: string; description: string; startsAt: number; endsAt: number;
  maxTicketsPerBuyer?: number; lineup: EventAct[]; posterPath?: string | null;
  curatorGenres?: string[]; doorsAt: number | null; ageRestriction: AgeRestriction;
}
interface SetEventTiersPayload {
  curatorProfileId: string; eventId: string;
  tiers: Array<{
    tierId?: string; name: string; priceCents: number; capacity: number;
    saleStartsAt: number | null; saleEndsAt: number | null;
  }>;
}

export type EventRow = { id: string } & EventDoc;

// Mirrors functions/src/eventsCore.ts's DEFAULT_MAX_TICKETS_PER_BUYER
// (module-private there, not exported to @gatekeep/shared, same boundary
// GigForms.tsx's own MAX_ADDRESS_LENGTH mirrors functions/src/gigs.ts's):
// only used as this field's placeholder/seed value, never load-bearing
// (updateEvent's own default applies server-side regardless of what this
// form sends).
const DEFAULT_MAX_TICKETS_PER_BUYER = 8;

const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (value: string): number | null => {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

export function ErrorBox({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
      <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}

// ---------- Lineup editor (shared by create + edit) ----------

interface TagEventArtistPayload { curatorProfileId: string; eventId: string; musicianProfileId: string; }
interface UntagEventArtistPayload { curatorProfileId: string; eventId: string; musicianProfileId: string; }

// Server-owned status copy (spec section 6): the curator sees this beside
// every tagged act, never invented or edited client-side.
const TAG_STATUS_LABEL: Record<TaggedActStatus, string> = { pending: "Pending", accepted: "Accepted", declined: "Declined" };

function LineupFields({ lineup, onChange, eventId, profileId }: {
  lineup: EventAct[]; onChange: (v: EventAct[]) => void; eventId: string | null; profileId: string;
}) {
  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const [untagBusyId, setUntagBusyId] = useState<string | null>(null);

  const addAct = () => {
    const name = draft.trim();
    if (!name) return;
    onChange([...lineup, { kind: "external", name }]);
    setDraft("");
  };

  // tagEventArtist is the ONLY writer of a `tagged` act (eventArtistTags.ts's
  // own header comment); this just mirrors its result locally (status
  // "pending", the id and name the picker already resolved) so the row
  // appears without a refetch. Save later resends this placeholder verbatim,
  // and the server's own reconcileTaggedActs replaces it with its stored
  // copy by musicianProfileId, so nothing here ever invents or edits status.
  const handlePick = async (musicianProfileId: string, name: string) => {
    if (!eventId) return;
    setTagError(null);
    try {
      await callFn<TagEventArtistPayload, { actIndex: number }>("tagEventArtist",
        { curatorProfileId: profileId, eventId, musicianProfileId });
      onChange([...lineup, { kind: "tagged", musicianProfileId, name, status: "pending", taggedAt: Date.now(), respondedAt: null }]);
    } catch (e) {
      // The three ARTIST_TAG_* messages are the whole vocabulary here
      // (duplicate, unapproved, cap); surfaced verbatim, same discipline as
      // every other callable rejection in this file.
      setTagError(e instanceof Error ? e.message : "Could not tag this artist.");
    }
  };

  const untag = async (musicianProfileId: string, index: number) => {
    if (!eventId) return;
    setTagError(null);
    setUntagBusyId(musicianProfileId);
    try {
      await callFn<UntagEventArtistPayload, { ok: true }>("untagEventArtist",
        { curatorProfileId: profileId, eventId, musicianProfileId });
      onChange(lineup.map((a, i) => (i === index ? { kind: "external", name: a.name } : a)));
    } catch (e) {
      setTagError(e instanceof Error ? e.message : "Could not untag this artist.");
    } finally {
      setUntagBusyId(null);
    }
  };

  return (
    <div className="grid gap-2">
      {lineup.length > 0 && (
        <ul className="grid gap-1.5">
          {lineup.map((act, i) => (
            <li key={`${act.kind}-${i}-${act.name}`} className="flex items-center justify-between gap-2 rounded-gk-sm border border-gk-border bg-gk-border/20 px-3 py-2">
              <span className="min-w-0 truncate font-sora text-sm text-gk-text">
                {act.name}
                {act.kind === "booking" && <span className="ml-1.5 font-sora text-xs text-gk-muted">(booked act)</span>}
                {act.kind === "tagged" && <span className="ml-1.5 font-sora text-xs text-gk-muted">{TAG_STATUS_LABEL[act.status]}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {act.kind === "tagged" && (
                  <Button
                    type="button" variant="ghost" size="sm"
                    onClick={() => void untag(act.musicianProfileId, i)}
                    disabled={untagBusyId === act.musicianProfileId}
                  >
                    {untagBusyId === act.musicianProfileId ? "Untagging…" : "Untag"}
                  </Button>
                )}
                <button
                  type="button" aria-label={`Remove ${act.name}`}
                  onClick={() => onChange(lineup.filter((_, idx) => idx !== i))}
                  className="shrink-0 rounded-gk-sm p-1 text-gk-muted outline-none hover:text-gk-destructive focus-visible:ring-2 focus-visible:ring-gk-focus"
                >
                  <IconTrash size={14} aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Input
          value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Act name" maxLength={80}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAct(); } }}
        />
        <Button type="button" variant="secondary" onClick={addAct} disabled={!draft.trim()}>
          <IconPlus size={16} aria-hidden="true" />
          Add act
        </Button>
        <Button type="button" variant="secondary" onClick={() => setPickerOpen(true)} disabled={!eventId}>
          <IconPlus size={16} aria-hidden="true" />
          Tag a GateKeep artist
        </Button>
      </div>
      {/* tagEventArtist requires a real eventId (it appends to a stored
          document); the create form has none yet, so this stays name-only
          until the first save. */}
      {!eventId && <p className="font-sora text-xs text-gk-muted">Save the event first, then tag artists.</p>}
      {tagError && <ErrorBox message={tagError} />}
      <p className="font-sora text-xs text-gk-muted">At least one act is required.</p>
      <ArtistPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={(id, name) => { void handlePick(id, name); }} />
    </div>
  );
}

// ---------- Genres editor (shared by create + edit) ----------

// Controller ruling (Task 3, surfaced here since Task 9 is the first UI for
// it): a curator can override the event's discovery genres directly, for
// when its lineup is all external acts with no GateKeep profile of their
// own to derive genres from (EventDoc.genres' own doc comment: curatorGenres
// wins when set, else the union of lineup booking acts' portfolio.genres).
// Reuses PortfolioForms' own Chip (Button size="sm", aria-pressed, pill
// radius), the same toggle-chip control BioGenresForm and GenrePicker
// already use for the identical "pick up to 3 from GENRES" shape, so this
// doesn't invent a fourth genre-picker treatment.
function GenresFields({ selected, onChange }: { selected: string[]; onChange: (v: string[]) => void }) {
  const atCap = selected.length >= 3;
  const toggle = (g: string) =>
    onChange(selected.includes(g) ? selected.filter((x) => x !== g) : selected.length < 3 ? [...selected, g] : selected);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {/* Once 3 are selected, an unselected chip disables rather than
            accepting a silent no-op click (toggle's own `selected.length < 3`
            guard already refuses the fourth pick; this makes that refusal
            visible on the chip itself). An already-selected chip stays
            enabled so it can still be deselected at the cap. Parity with the
            RN twin, which took this in its own fix round. */}
        {GENRES.map((g) => {
          const active = selected.includes(g);
          return (
            <Chip key={g} active={active} disabled={atCap && !active} onClick={() => toggle(g)}>
              {formatChipLabel(g)}
            </Chip>
          );
        })}
      </div>
      <p className="font-sora text-xs text-gk-muted">Used when your acts have no GateKeep profile. Up to three.</p>
    </div>
  );
}

// ---------- Tier editor ----------

interface TierRowState {
  key: string; tierId?: string; name: string; priceDollars: string; capacity: string;
  saleStartsAt: string; saleEndsAt: string; soldCount: number;
}
const blankTierRow = (): TierRowState =>
  ({ key: crypto.randomUUID(), name: "General admission", priceDollars: "", capacity: "", saleStartsAt: "", saleEndsAt: "", soldCount: 0 });
const tierRowFrom = (id: string, t: TicketTierDoc): TierRowState => ({
  key: id, tierId: id, name: t.name, priceDollars: (t.priceCents / 100).toString(), capacity: String(t.capacity),
  saleStartsAt: t.saleStartsAt ? toLocalInput(t.saleStartsAt) : "", saleEndsAt: t.saleEndsAt ? toLocalInput(t.saleEndsAt) : "",
  soldCount: t.soldCount,
});

// Seeded ONCE from `initialTiers` (a useState initializer, never re-synced
// from a later prop update): same discipline GigEditForm's own content
// state uses against the parent's live gig snapshot, so neither a sale
// happening mid-edit (moving soldCount) nor this form's own save (which
// echoes right back through the parent's tiers listener) wipes an
// in-progress edit out from under the curator. The call site remounts this
// with a fresh `key` only when switching to a genuinely different event.
function TierEditor({ profileId, eventId, eventStatus, initialTiers }: {
  profileId: string; eventId: string; eventStatus: EventStatus; initialTiers: TierRowState[];
}) {
  const [rows, setRows] = useState<TierRowState[]>(initialTiers.length > 0 ? initialTiers : [blankTierRow()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const isDraft = eventStatus === "draft";

  const update = (key: string, patch: Partial<TierRowState>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key));
  const add = () => setRows((prev) => [...prev, blankTierRow()]);

  const save = async () => {
    setError(null);
    setSaved(false);
    const tiers: SetEventTiersPayload["tiers"] = [];
    for (const r of rows) {
      const name = r.name.trim();
      if (!name) { setError("Every tier needs a name."); return; }
      const priceDollars = Number(r.priceDollars);
      if (r.priceDollars.trim() === "" || !Number.isFinite(priceDollars) || priceDollars < 0) {
        setError(`Enter a price for "${name}" (0 for free).`);
        return;
      }
      const capacity = Number(r.capacity);
      if (r.capacity.trim() === "" || !Number.isInteger(capacity) || capacity < 1) {
        setError(`Enter a whole-number capacity for "${name}".`);
        return;
      }
      tiers.push({
        tierId: r.tierId, name, priceCents: Math.round(priceDollars * 100), capacity,
        saleStartsAt: fromLocalInput(r.saleStartsAt), saleEndsAt: fromLocalInput(r.saleEndsAt),
      });
    }
    setBusy(true);
    try {
      await callFn<SetEventTiersPayload, { ok: true }>("setEventTiers",
        { curatorProfileId: profileId, eventId, tiers });
      setSaved(true);
      // Refetch (a one-shot read, same idiom BuyTicketsFlow.tsx's own
      // refetchTiers uses for the identical reason) rather than trusting
      // this form's own optimistic state: picks up server-assigned tier
      // ids for brand-new rows and the fresh sortOrder/soldCount, so a
      // second save in the same sitting has real ids to upsert against
      // instead of minting duplicate tiers.
      const snap = await getDocs(query(collection(getFirebase().db, `events/${eventId}/tiers`), orderBy("sortOrder")));
      setRows(snap.docs.map((d) => tierRowFrom(d.id, d.data() as TicketTierDoc)));
    } catch (e) {
      // Surfaced verbatim: setEventTiers' own rejections (deletion while
      // published, a capacity drop below soldCount, the 1-N tier count
      // bound) are already self-explanatory, specific server copy naming
      // the exact tier at fault (functions/src/events.ts).
      setError(e instanceof Error ? e.message : "Could not save ticket tiers.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      {rows.map((r) => (
        <div key={r.key} className="grid gap-2 rounded-gk border border-gk-border bg-gk-surface p-3.5">
          <div className="flex items-start gap-2">
            <Input
              value={r.name} onChange={(e) => update(r.key, { name: e.target.value })}
              placeholder="Tier name" maxLength={40} aria-label="Tier name" className="flex-1"
            />
            {/* Removal is unconditional client-side for a NEW row (no
                tierId yet: nothing on the server to protect), and for an
                EXISTING row only while the event is still a draft, mirroring
                setEventTiers' own "tiers can only be removed while draft"
                gate exactly (functions/src/events.ts) so this never offers a
                control the server would just reject. */}
            {(!r.tierId || isDraft) && (
              <button
                type="button" aria-label={`Remove tier ${r.name || ""}`}
                onClick={() => remove(r.key)}
                className="shrink-0 rounded-gk-sm p-2 text-gk-muted outline-none hover:text-gk-destructive focus-visible:ring-2 focus-visible:ring-gk-focus"
              >
                <IconTrash size={16} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <span className="font-sora text-sm text-gk-muted">$</span>
              <Input
                type="number" min={0} step="0.01" className="w-24" aria-label="Price"
                value={r.priceDollars} onChange={(e) => update(r.key, { priceDollars: e.target.value })}
              />
            </div>
            <Input
              type="number" min={r.soldCount || 1} step={1} className="w-28" aria-label="Capacity" placeholder="Capacity"
              value={r.capacity} onChange={(e) => update(r.key, { capacity: e.target.value })}
            />
            {r.tierId && r.soldCount > 0 && (
              <span className="font-sora text-xs text-gk-muted">{r.soldCount} sold</span>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1">
              <label className="font-sora text-xs text-gk-muted">Sale starts (optional)</label>
              <Input type="datetime-local" className="w-56" value={r.saleStartsAt} onChange={(e) => update(r.key, { saleStartsAt: e.target.value })} />
            </div>
            <div className="grid gap-1">
              <label className="font-sora text-xs text-gk-muted">Sale ends (optional)</label>
              <Input type="datetime-local" className="w-56" value={r.saleEndsAt} onChange={(e) => update(r.key, { saleEndsAt: e.target.value })} />
            </div>
          </div>
        </div>
      ))}
      <Button type="button" variant="secondary" onClick={add} className="w-fit">
        <IconPlus size={16} aria-hidden="true" />
        Add tier
      </Button>
      {error && <ErrorBox message={error} />}
      {saved && !error && <p className="font-sora text-sm text-gk-success">Ticket tiers saved.</p>}
      <Button type="button" onClick={save} disabled={busy} className="w-fit">
        {busy ? "Saving…" : "Save ticket tiers"}
      </Button>
    </div>
  );
}

// ---------- Cancel confirm panel ----------

function CancelPanel({ profileId, eventId, title, onClose, onCancelled }: {
  profileId: string; eventId: string; title: string; onClose: () => void; onCancelled: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await callFn("cancelEvent",
        { curatorProfileId: profileId, eventId, reason: reason.trim() || undefined });
      onCancelled();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel this event.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-gk-destructive/40 bg-gk-destructive/14 p-4">
      <CardContent className="grid gap-3 p-0">
        <p className="font-syne text-base font-semibold text-gk-text">Cancel &quot;{title}&quot;?</p>
        {/* Controller ruling 2 (binding): the confirm panel must spell out
            that cancelEvent auto-refunds everything, verbatim. */}
        <p className="flex items-start gap-2 font-sora text-sm text-gk-destructive">
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          This cancels the event and automatically refunds every ticket already sold, in full. This can&apos;t be undone.
        </p>
        <Textarea rows={2} maxLength={500} value={reason} disabled={busy}
          onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional, shown to ticket holders)" />
        {error && <ErrorBox message={error} />}
        <div className="flex gap-2">
          <Button onClick={submit} disabled={busy} variant="destructive">
            {busy ? "Cancelling…" : "Confirm cancellation"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Back</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Create form ----------

function EventCreateForm({ profileId, isVenue, curatorAddress, source, seedTitle, seedStartsAt, seedLineup, onCreated }: {
  profileId: string; isVenue: boolean; curatorAddress: string | null; source: EventSourceInput;
  seedTitle?: string; seedStartsAt?: number; seedLineup?: EventAct[];
  onCreated: (eventId: string) => void;
}) {
  const [title, setTitle] = useState(seedTitle ?? "");
  const [description, setDescription] = useState("");
  const [startsAtInput, setStartsAtInput] = useState(seedStartsAt ? toLocalInput(seedStartsAt) : "");
  const [endsAtInput, setEndsAtInput] = useState(seedStartsAt ? toLocalInput(seedStartsAt + 2 * 3_600_000) : "");
  const [doorsInput, setDoorsInput] = useState("");
  const [age, setAge] = useState<AgeRestriction>("all_ages");
  const [lineup, setLineup] = useState<EventAct[]>(seedLineup ?? []);
  const [genres, setGenres] = useState<string[]>([]);
  const [location, setLocation] = useState<LocationValue>({ address: "", visibility: isVenue ? "public" : "neighborhood" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const trimmedTitle = title.trim();
    if (trimmedTitle.length < 1 || trimmedTitle.length > 120) { setError("Title must be 1-120 characters."); return; }
    const startsAt = fromLocalInput(startsAtInput);
    const endsAt = fromLocalInput(endsAtInput);
    if (startsAt == null) { setError("Pick a start date and time."); return; }
    if (endsAt == null || endsAt <= startsAt) { setError("End time must be after the start time."); return; }
    if (startsAt <= Date.now()) { setError("Start time must be in the future."); return; }
    if (lineup.length === 0) { setError("Add at least one act to the lineup."); return; }
    // Client-side hint mirroring validateEventInput's own doors rule
    // (functions/src/eventsCore.ts): a light UX pre-check only, the server
    // remains the sole authority.
    const doorsAt = doorsInput ? fromLocalInput(doorsInput) : null;
    if (doorsInput && (doorsAt == null || doorsAt >= startsAt || startsAt - doorsAt > DOORS_MAX_BEFORE_START_MS)) {
      setError(EVENT_DOORS_MESSAGE); return;
    }

    let resolvedSource: EventSourceInput = source;
    if (source.kind === "standalone") {
      const trimmedAddress = location.address.trim();
      if (!isVenue && trimmedAddress.length === 0) { setError("An address is required for this event."); return; }
      if (trimmedAddress.length > MAX_ADDRESS_LENGTH) { setError(`Address must be at most ${MAX_ADDRESS_LENGTH} characters.`); return; }
      resolvedSource = { kind: "standalone", location: { address: trimmedAddress || null, addressVisibility: location.visibility } };
    }

    setBusy(true);
    try {
      const payload: CreateEventPayload = {
        curatorProfileId: profileId, source: resolvedSource, title: trimmedTitle, description: description.trim(),
        startsAt, endsAt, lineup, curatorGenres: genres.length > 0 ? genres : undefined,
        doorsAt, ageRestriction: age,
      };
      const { data } = await callFn<CreateEventPayload, { eventId: string }>("createEvent", payload);
      onCreated(data.eventId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create this event.");
    } finally {
      setBusy(false);
    }
  };

  const currentLabel = source.kind === "gig"
    ? "This event's location comes from the promoted gig."
    : isVenue
      ? (curatorAddress ? `Your venue's address on file: ${curatorAddress}` : "No venue address on file yet.")
      : "Enter the address for this event.";

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1.5">
            <label htmlFor="event-title" className="font-sora text-sm font-medium text-gk-text">Title</label>
            <Input id="event-title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="event-description" className="font-sora text-sm font-medium text-gk-text">Description</label>
            <Textarea id="event-description" rows={4} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="grid gap-1.5">
              <label htmlFor="event-starts" className="font-sora text-sm font-medium text-gk-text">Starts</label>
              <Input id="event-starts" type="datetime-local" value={startsAtInput} onChange={(e) => setStartsAtInput(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="event-ends" className="font-sora text-sm font-medium text-gk-text">Ends</label>
              <Input id="event-ends" type="datetime-local" value={endsAtInput} onChange={(e) => setEndsAtInput(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="event-doors" className="font-sora text-sm font-medium text-gk-text">Doors (optional)</label>
              <Input id="event-doors" type="datetime-local" value={doorsInput} onChange={(e) => setDoorsInput(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <span className="font-sora text-sm font-medium text-gk-text">Age</span>
            <div className="flex flex-wrap gap-2">
              {AGE_RESTRICTIONS.map((a) => (
                <Chip key={a} active={age === a} onClick={() => setAge(a)}>{AGE_RESTRICTION_LABEL[a]}</Chip>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Lineup</CardTitle></CardHeader>
        <CardContent><LineupFields lineup={lineup} onChange={setLineup} eventId={null} profileId={profileId} /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Genres (optional)</CardTitle></CardHeader>
        <CardContent><GenresFields selected={genres} onChange={setGenres} /></CardContent>
      </Card>

      {source.kind === "standalone" && (
        <Card>
          <CardHeader><CardTitle>Location</CardTitle></CardHeader>
          <CardContent>
            <LocationFields
              isVenue={isVenue} addressRequired={!isVenue} currentLabel={currentLabel} value={location} onChange={setLocation}
              entityNoun="event"
            />
          </CardContent>
        </Card>
      )}
      {source.kind === "gig" && <p className="font-sora text-sm text-gk-muted">{currentLabel}</p>}

      {error && <ErrorBox message={error} />}
      <Button type="button" onClick={submit} disabled={busy} className="justify-self-start">
        {busy ? "Creating…" : "Create event (draft)"}
      </Button>
    </div>
  );
}

// ---------- Edit form (content only; tiers/publish/cancel render alongside it) ----------

function EventEditContentForm({ profileId, event }: { profileId: string; event: EventRow }) {
  const [title, setTitle] = useState(event.title);
  const [description, setDescription] = useState(event.description);
  const [startsAtInput, setStartsAtInput] = useState(toLocalInput(event.startsAt));
  const [endsAtInput, setEndsAtInput] = useState(toLocalInput(event.endsAt));
  const [doorsInput, setDoorsInput] = useState(event.doorsAt ? toLocalInput(event.doorsAt) : "");
  const [age, setAge] = useState<AgeRestriction>(event.ageRestriction ?? "all_ages");
  const [maxTicketsPerBuyer, setMaxTicketsPerBuyer] = useState(String(event.maxTicketsPerBuyer ?? DEFAULT_MAX_TICKETS_PER_BUYER));
  const [lineup, setLineup] = useState<EventAct[]>(event.lineup);
  const [genres, setGenres] = useState<string[]>(event.curatorGenres ?? []);
  // Seeded once from the event like every other field here; PosterField
  // hands back the processed public path (or null on Remove) and Save below
  // carries it in the same full-replace payload as the rest.
  const [posterPath, setPosterPath] = useState<string | null>(event.posterPath ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setError(null);
    setSaved(false);
    const trimmedTitle = title.trim();
    if (trimmedTitle.length < 1 || trimmedTitle.length > 120) { setError("Title must be 1-120 characters."); return; }
    const startsAt = fromLocalInput(startsAtInput);
    const endsAt = fromLocalInput(endsAtInput);
    if (startsAt == null) { setError("Pick a start date and time."); return; }
    if (endsAt == null || endsAt <= startsAt) { setError("End time must be after the start time."); return; }
    if (lineup.length === 0) { setError("Add at least one act to the lineup."); return; }
    const maxTix = Number(maxTicketsPerBuyer);
    if (!Number.isInteger(maxTix) || maxTix < 1 || maxTix > 20) { setError("Max tickets per buyer must be a whole number from 1 to 20."); return; }
    // Client-side hint mirroring validateEventInput's own doors rule
    // (functions/src/eventsCore.ts): a light UX pre-check only, the server
    // remains the sole authority.
    const doorsAt = doorsInput ? fromLocalInput(doorsInput) : null;
    if (doorsInput && (doorsAt == null || doorsAt >= startsAt || startsAt - doorsAt > DOORS_MAX_BEFORE_START_MS)) {
      setError(EVENT_DOORS_MESSAGE); return;
    }

    setBusy(true);
    try {
      const payload: UpdateEventPayload = {
        curatorProfileId: profileId, eventId: event.id, title: trimmedTitle, description: description.trim(),
        startsAt, endsAt, maxTicketsPerBuyer: maxTix, lineup, doorsAt, ageRestriction: age,
        // Fix round 1 (Minor, review): the current selection is always
        // resent, never carried forward as "no change" (updateEvent's own
        // full-replace convention, same discipline this payload's posterPath
        // field just below follows). It can't be sent as a bare empty array
        // though: validateCuratorGenres (functions/src/eventsCore.ts) treats
        // undefined/null as "not provided" but throws "Pick 1-3 genres." on
        // any array shorter than 1, so an empty selection has to go as
        // `undefined`, not `[]`. That's still "always resend the current
        // selection", not "no change": updateEvent stores `curatorGenres ??
        // []`, so an absent field here is what CLEARS a previously-set
        // selection server-side, exactly matching an empty `genres` here.
        curatorGenres: genres.length > 0 ? genres : undefined,
        // updateEvent's full-replace convention treats an absent posterPath
        // as "clear it" (resolvePosterPath returns null for undefined and
        // null alike), so the current value is always sent explicitly: the
        // one PosterField picked, or the event's own when it was untouched.
        posterPath,
      };
      await callFn("updateEvent", payload);
      setSaved(true);
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
        <CardContent className="grid gap-4">
          <div className="grid gap-1.5">
            <label htmlFor="event-edit-title" className="font-sora text-sm font-medium text-gk-text">Title</label>
            <Input id="event-edit-title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="event-edit-description" className="font-sora text-sm font-medium text-gk-text">Description</label>
            <Textarea id="event-edit-description" rows={4} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="grid gap-1.5">
              <label htmlFor="event-edit-starts" className="font-sora text-sm font-medium text-gk-text">Starts</label>
              <Input id="event-edit-starts" type="datetime-local" value={startsAtInput} onChange={(e) => setStartsAtInput(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="event-edit-ends" className="font-sora text-sm font-medium text-gk-text">Ends</label>
              <Input id="event-edit-ends" type="datetime-local" value={endsAtInput} onChange={(e) => setEndsAtInput(e.target.value)} />
            </div>
            <div className="grid max-w-40 gap-1.5">
              <label htmlFor="event-edit-max-tix" className="font-sora text-sm font-medium text-gk-text">Max tickets/buyer</label>
              <Input id="event-edit-max-tix" type="number" min={1} max={20} value={maxTicketsPerBuyer} onChange={(e) => setMaxTicketsPerBuyer(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="event-edit-doors" className="font-sora text-sm font-medium text-gk-text">Doors (optional)</label>
              <Input id="event-edit-doors" type="datetime-local" value={doorsInput} onChange={(e) => setDoorsInput(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <span className="font-sora text-sm font-medium text-gk-text">Age</span>
            <div className="flex flex-wrap gap-2">
              {AGE_RESTRICTIONS.map((a) => (
                <Chip key={a} active={age === a} onClick={() => setAge(a)}>{AGE_RESTRICTION_LABEL[a]}</Chip>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Poster</CardTitle></CardHeader>
        <CardContent>
          <PosterField curatorProfileId={profileId} value={posterPath} onChange={setPosterPath} disabled={busy} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Lineup</CardTitle></CardHeader>
        <CardContent><LineupFields lineup={lineup} onChange={setLineup} eventId={event.id} profileId={profileId} /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Genres (optional)</CardTitle></CardHeader>
        <CardContent><GenresFields selected={genres} onChange={setGenres} /></CardContent>
      </Card>

      {error && <ErrorBox message={error} />}
      {saved && !error && <p className="font-sora text-sm text-gk-success">Changes saved.</p>}
      <Button type="button" onClick={save} disabled={busy} className="justify-self-start">
        {busy ? "Saving…" : "Save changes"}
      </Button>
    </div>
  );
}

// ---------- The public component ----------

export type EventEditorMode =
  | { kind: "create"; source: EventSourceInput; seedTitle?: string; seedStartsAt?: number; seedLineup?: EventAct[] }
  | { kind: "edit"; event: EventRow; initialTiers: TierRowState[] };

export function EventEditor({ profileId, isVenue, curatorAddress, mode, onClose, onCreated, onCancelled }: {
  profileId: string; isVenue: boolean; curatorAddress: string | null;
  mode: EventEditorMode;
  onClose: () => void;
  onCreated: (eventId: string) => void;
  onCancelled: () => void;
}) {
  const [showCancel, setShowCancel] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  if (mode.kind === "create") {
    return (
      <EventCreateForm
        profileId={profileId} isVenue={isVenue} curatorAddress={curatorAddress} source={mode.source}
        seedTitle={mode.seedTitle} seedStartsAt={mode.seedStartsAt} seedLineup={mode.seedLineup} onCreated={onCreated}
      />
    );
  }

  const { event, initialTiers } = mode;
  const editable = event.status === "draft" || event.status === "published";

  const publish = async () => {
    setPublishBusy(true);
    setPublishError(null);
    try {
      await callFn("publishEvent", { curatorProfileId: profileId, eventId: event.id });
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : "Could not publish.");
    } finally {
      setPublishBusy(false);
    }
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-syne text-2xl font-bold text-gk-text">{event.title || "Untitled event"}</h2>
        <Badge variant={EVENT_STATUS_BADGE[event.status]}>{EVENT_STATUS_LABEL[event.status]}</Badge>
      </div>
      {event.gigId && <p className="font-sora text-xs text-gk-muted">Promoted from a booked gig.</p>}

      {!editable && (
        <p className="font-sora text-sm text-gk-muted">
          This event is {EVENT_STATUS_LABEL[event.status].toLowerCase()} and can no longer be edited.
        </p>
      )}
      {editable && <EventEditContentForm key={event.id} profileId={profileId} event={event} />}

      <div className="border-t border-gk-border pt-6">
        <h3 className="font-syne text-lg font-semibold text-gk-text">Ticket tiers</h3>
        <div className="mt-3">
          <TierEditor key={event.id} profileId={profileId} eventId={event.id} eventStatus={event.status} initialTiers={initialTiers} />
        </div>
      </div>

      {event.status === "draft" && (
        <div className="border-t border-gk-border pt-6">
          <Button type="button" onClick={publish} disabled={publishBusy} className="justify-self-start">
            {publishBusy ? "Publishing…" : "Publish event"}
          </Button>
          {publishError && <div className="mt-3"><ErrorBox message={publishError} /></div>}
        </div>
      )}

      {editable && (
        <div className="border-t border-gk-border pt-6">
          {showCancel ? (
            <CancelPanel
              profileId={profileId} eventId={event.id} title={event.title}
              onClose={() => setShowCancel(false)} onCancelled={onCancelled}
            />
          ) : (
            <Button type="button" variant="link" onClick={() => setShowCancel(true)} className="h-auto justify-self-start p-0 text-gk-destructive">
              Cancel this event
            </Button>
          )}
        </div>
      )}

      <Button type="button" variant="secondary" onClick={onClose} className="justify-self-start">Back to events</Button>
    </div>
  );
}

export { tierRowFrom, type TierRowState };
