/**
 * SP11 (spec section 3.5 and 5): curator-tagged GateKeep artists on events
 * that are not tied to a booking. This file is the ONLY writer of a lineup
 * act's `kind: "tagged"` entry: events.ts's update path preserves what it
 * finds here (reconcileTaggedActs) and never accepts a new one from a
 * client, so a curator cannot fabricate "X plays our venue" on X's own
 * public page, which is exactly the guarantee verifyLineupBookingActs gives
 * booking acts.
 *
 * The public rendering rule the clients implement: a tagged act reads as a
 * plain name until it is "accepted"; only an accepted act joins
 * lineupMusicianProfileIds and therefore the artist page, the search index,
 * show posts, and the reschedule fan-out.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import {
  isValidDocId, ARTIST_TAG_DUPLICATE_MESSAGE, ARTIST_TAG_UNAPPROVED_MESSAGE,
  ARTIST_TAG_ANSWERED_MESSAGE, ARTIST_TAG_UNKNOWN_MESSAGE, ARTIST_TAG_EVENT_CLOSED_MESSAGE,
  type EventAct, type EventDoc, type ProfileDoc, type TaggedActStatus,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { requireProfileAdmin } from "./profiles.js";
import { notifyProfileAdmins } from "./notifications.js";
import { notifyFollowers } from "./follows.js";
import { artistTagNote, showAnnouncedNote } from "./announce.js";

const MAX_LINEUP_ACTS = 20;

type TaggedAct = Extract<EventAct, { kind: "tagged" }>;

// Fix round 1 (Important 3): keyed on taggedAt too, so a re-tag (a fresh
// taggedAt, whether this is the artist's first time on this bill or a
// re-tag after an untag) always gets its own notification. Without the
// timestamp, a re-tag would replay the FIRST tag's spent key and the artist
// would never hear about the second one.
export const artistTagDedupeKey = (eventId: string, musicianProfileId: string, taggedAt: number) =>
  `artist_tag:${eventId}:${musicianProfileId}:${taggedAt}`;

function taggedIn(lineup: EventAct[], musicianProfileId: string): TaggedAct | undefined {
  return lineup.find((a): a is TaggedAct => a.kind === "tagged" && a.musicianProfileId === musicianProfileId);
}

function alreadyOnLineup(lineup: EventAct[], musicianProfileId: string): boolean {
  return lineup.some((a) =>
    (a.kind === "booking" || a.kind === "tagged") && a.musicianProfileId === musicianProfileId);
}

// EventDoc.lineupMusicianProfileIds: booking acts plus ACCEPTED tagged acts.
// Kept here rather than in events.ts because both files derive it now and
// this one owns the tagged half of the rule.
export function deriveLineupMusicianProfileIds(lineup: EventAct[]): string[] {
  const ids = new Set<string>();
  for (const act of lineup) {
    if (act.kind === "booking") ids.add(act.musicianProfileId);
    if (act.kind === "tagged" && act.status === "accepted") ids.add(act.musicianProfileId);
  }
  return [...ids];
}

// updateEvent replaces the lineup wholesale, so an incoming payload carries
// the tagged acts the editor last read. Every tagged entry is replaced by the
// SERVER's own copy (status, name, taggedAt, respondedAt), and an entry the
// server has never seen is refused: tags are created only by
// tagEventArtist. An omitted entry is a removal, which is the existing
// lineup edit path and needs no special handling here.
export function reconcileTaggedActs(stored: EventAct[], incoming: EventAct[]): EventAct[] {
  return incoming.map((act) => {
    if (act.kind !== "tagged") return act;
    const known = taggedIn(stored, act.musicianProfileId);
    if (!known) throw new HttpsError("invalid-argument", ARTIST_TAG_UNKNOWN_MESSAGE);
    return known;
  });
}

async function loadOwnedEvent(
  db: Firestore, curatorProfileId: string, eventId: string,
): Promise<{ ref: FirebaseFirestore.DocumentReference; event: EventDoc }> {
  const ref = db.doc(`events/${eventId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Event not found.");
  const event = snap.data() as EventDoc;
  if (event.curatorProfileId !== curatorProfileId) {
    throw new HttpsError("permission-denied", "That event does not belong to this curator profile.");
  }
  if (event.status !== "draft" && event.status !== "published") {
    throw new HttpsError("failed-precondition", `Cannot change the lineup of an event in status "${event.status}".`);
  }
  return { ref, event };
}

// Post-commit and best-effort, the repo's fan-out posture: the tag is
// already written, so a notify failure must never surface as an error on it.
// Keyed on the ACT's own taggedAt (not "now"): notifyPendingTags calls this
// with an act read earlier in the same request, and the key must match the
// one a publish-time tag would have minted for that exact tag.
async function tellTaggedAdmins(
  eventId: string, event: EventDoc, curatorName: string, act: TaggedAct,
): Promise<void> {
  try {
    await notifyProfileAdmins(act.musicianProfileId,
      artistTagNote(eventId, event, curatorName), artistTagDedupeKey(eventId, act.musicianProfileId, act.taggedAt));
  } catch (e) {
    console.error(`artist tag: notify failed for event ${eventId} artist ${act.musicianProfileId}`, e);
  }
}

// publishEvent's hook: every act still "pending" at publish time hears about
// it now, under the same per-artist-per-tag key a publish-time tag already
// used, so a tag made while the event was published and a later publish (of
// a re-drafted event) can never double-send.
export async function notifyPendingTags(db: Firestore, eventId: string, event: EventDoc): Promise<void> {
  const pending = (event.lineup ?? []).filter((a): a is TaggedAct => a.kind === "tagged" && a.status === "pending");
  if (pending.length === 0) return;
  const curatorName = ((await db.doc(`profiles/${event.curatorProfileId}`).get()).data() as ProfileDoc | undefined)?.name
    ?? "A GateKeep organizer";
  for (const act of pending) await tellTaggedAdmins(eventId, event, curatorName, act);
}

export const tagEventArtist = onCall<{ curatorProfileId: string; eventId: string; musicianProfileId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { curatorProfileId, eventId, musicianProfileId } = req.data ?? {};
    if (!isValidDocId(curatorProfileId) || !isValidDocId(eventId) || !isValidDocId(musicianProfileId)) {
      throw new HttpsError("invalid-argument", "A curator profile, an event, and an artist are required.");
    }
    await requireProfileAdmin(curatorProfileId, uid);

    const db = getFirestore();
    const { ref, event } = await loadOwnedEvent(db, curatorProfileId, eventId);
    const artistSnap = await db.doc(`profiles/${musicianProfileId}`).get();
    const artist = artistSnap.data() as ProfileDoc | undefined;
    if (!artist || artist.type !== "musician" || artist.status !== "approved") {
      throw new HttpsError("failed-precondition", ARTIST_TAG_UNAPPROVED_MESSAGE);
    }

    const now = Date.now();
    const { actIndex, act } = await db.runTransaction(async (tx) => {
      const fresh = (await tx.get(ref)).data() as EventDoc | undefined;
      if (!fresh) throw new HttpsError("not-found", "Event not found.");
      const lineup = fresh.lineup ?? [];
      if (alreadyOnLineup(lineup, musicianProfileId)) {
        throw new HttpsError("failed-precondition", ARTIST_TAG_DUPLICATE_MESSAGE);
      }
      const tagged: TaggedAct = {
        kind: "tagged", musicianProfileId, name: artist.name,
        status: "pending", taggedAt: now, respondedAt: null,
      };
      // Fix round 1 (Important 3): untagEventArtist turns a removed tag into
      // a plain { kind: "external", name } act rather than deleting it (the
      // show still has that act). Re-tagging the SAME artist name is that
      // act coming back, not a new one, so it is converted in place: this
      // both avoids a duplicate "The Act" row and keeps it out of the cap
      // count, which only guards a genuinely NEW row.
      const matchIndex = lineup.findIndex((a) =>
        a.kind === "external" && a.name.trim().toLowerCase() === artist.name.trim().toLowerCase());
      let next: EventAct[];
      let index: number;
      if (matchIndex >= 0) {
        next = lineup.map((a, i) => (i === matchIndex ? tagged : a));
        index = matchIndex;
      } else {
        if (lineup.length >= MAX_LINEUP_ACTS) {
          throw new HttpsError("failed-precondition", `Lineup must have 1-${MAX_LINEUP_ACTS} acts.`);
        }
        next = [...lineup, tagged];
        index = next.length - 1;
      }
      tx.update(ref, { lineup: next, lineupMusicianProfileIds: deriveLineupMusicianProfileIds(next), updatedAt: now });
      return { actIndex: index, act: tagged };
    });

    // A draft tag stays silent; publishEvent's notifyPendingTags tells them.
    if (event.status === "published") {
      const curatorName = ((await db.doc(`profiles/${curatorProfileId}`).get()).data() as ProfileDoc | undefined)?.name
        ?? "A GateKeep organizer";
      await tellTaggedAdmins(eventId, event, curatorName, act);
    }
    return { actIndex };
  });

export const untagEventArtist = onCall<{ curatorProfileId: string; eventId: string; musicianProfileId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { curatorProfileId, eventId, musicianProfileId } = req.data ?? {};
    if (!isValidDocId(curatorProfileId) || !isValidDocId(eventId) || !isValidDocId(musicianProfileId)) {
      throw new HttpsError("invalid-argument", "A curator profile, an event, and an artist are required.");
    }
    await requireProfileAdmin(curatorProfileId, uid);
    const db = getFirestore();
    const { ref } = await loadOwnedEvent(db, curatorProfileId, eventId);
    const now = Date.now();
    await db.runTransaction(async (tx) => {
      const fresh = (await tx.get(ref)).data() as EventDoc | undefined;
      if (!fresh) throw new HttpsError("not-found", "Event not found.");
      const lineup = fresh.lineup ?? [];
      if (!taggedIn(lineup, musicianProfileId)) throw new HttpsError("not-found", "That artist is not tagged on this lineup.");
      // The act stays on the bill as a plain external name (the show still
      // has that act), it just stops claiming a GateKeep artist. Removing it
      // entirely is the existing lineup edit path.
      const next: EventAct[] = lineup.map((a) =>
        a.kind === "tagged" && a.musicianProfileId === musicianProfileId ? { kind: "external", name: a.name } : a);
      tx.update(ref, { lineup: next, lineupMusicianProfileIds: deriveLineupMusicianProfileIds(next), updatedAt: now });
    });
    return { ok: true };
  });

export const respondToArtistTag = onCall<{ eventId: string; musicianProfileId: string; accept: boolean }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { eventId, musicianProfileId, accept } = req.data ?? {};
    if (!isValidDocId(eventId) || !isValidDocId(musicianProfileId)) {
      throw new HttpsError("invalid-argument", "An event and an artist are required.");
    }
    if (typeof accept !== "boolean") throw new HttpsError("invalid-argument", "Accept or decline.");
    await requireProfileAdmin(musicianProfileId, uid);

    const db = getFirestore();
    const ref = db.doc(`events/${eventId}`);
    const now = Date.now();
    const status: TaggedActStatus = accept ? "accepted" : "declined";
    const event = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "Event not found.");
      const fresh = snap.data() as EventDoc;
      // Fix round 1 (Important 2): loadOwnedEvent already refuses a
      // tagEventArtist/untagEventArtist call against a closed event; this is
      // the same gate on the answer side, since a cancelled event's lineup
      // must not keep changing underneath it.
      if (fresh.status !== "draft" && fresh.status !== "published") {
        throw new HttpsError("failed-precondition", ARTIST_TAG_EVENT_CLOSED_MESSAGE);
      }
      const act = taggedIn(fresh.lineup ?? [], musicianProfileId);
      if (!act) throw new HttpsError("not-found", "That artist is not tagged on this lineup.");
      if (act.status !== "pending") throw new HttpsError("failed-precondition", ARTIST_TAG_ANSWERED_MESSAGE);
      const next: EventAct[] = (fresh.lineup ?? []).map((a) =>
        a.kind === "tagged" && a.musicianProfileId === musicianProfileId
          ? { ...a, status, respondedAt: now } : a);
      tx.update(ref, { lineup: next, lineupMusicianProfileIds: deriveLineupMusicianProfileIds(next), updatedAt: now });
      return { ...fresh, lineup: next, lineupMusicianProfileIds: deriveLineupMusicianProfileIds(next) };
    });

    // Accepting on a PUBLISHED event announces the show to this artist's own
    // followers, under the publish path's own key (`announce:{eventId}`), so
    // a fan who already heard about this event hears nothing twice and a
    // later re-announce cannot double-send. Decline and untag tell nobody.
    if (accept && event.status === "published") {
      try {
        await notifyFollowers([musicianProfileId], showAnnouncedNote(eventId, event), `announce:${eventId}`);
      } catch (e) {
        console.error(`respondToArtistTag: announce fan-out failed for event ${eventId}`, e);
      }
    }
    return { ok: true, status };
  });
