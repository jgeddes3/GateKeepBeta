/**
 * SP7 Task 5: note builders shared by the two follower fan-out hooks
 * (events.ts's publishEvent/updateEvent and tracks.ts's reviewTrack).
 * Deliberately pure: no Firestore reads/writes here, just note shaping.
 * follows.ts's notifyFollowers and notifications.ts's notifyUser own all
 * persistence.
 */

import { genreTargetId, LAUNCH_TIMEZONE, type EventDoc, type NotificationDoc } from "@gatekeep/shared";

type Note = Omit<NotificationDoc, "read" | "createdAt">;

export function formatShowDate(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: LAUNCH_TIMEZONE, weekday: "short", month: "short", day: "numeric" })
    .format(new Date(ms));
}

function billing(event: EventDoc): string {
  const names = event.lineup.map((a) => a.name.trim()).filter(Boolean);
  return names.length > 0 ? names.slice(0, 3).join(", ") + (names.length > 3 ? " and more" : "") : event.title;
}

function venue(event: EventDoc): string { return event.location.venueName ?? event.location.city; }

// The follower fan-out targets for a "show announced" style note: the
// event's curator, every lineup act's musician profile, and its genre
// targets. Shared by publishEvent's whole-event announce and updateEvent's
// added-lineup-artist announce (the caller passes only the NEW ids for the
// latter, not this function's output).
export function announceTargets(event: EventDoc): string[] {
  return [event.curatorProfileId, ...event.lineupMusicianProfileIds, ...(event.genres ?? []).map(genreTargetId)];
}

export function showAnnouncedNote(eventId: string, event: EventDoc): Note {
  return {
    kind: "show_announced", refId: eventId, title: "Show announced",
    body: `${billing(event)} at ${venue(event)}, ${formatShowDate(event.startsAt)}.`,
  };
}

export function onTheBillNote(eventId: string, event: EventDoc): Note {
  return {
    kind: "show_announced", refId: eventId, title: "You're on the bill",
    body: `${event.title} at ${venue(event)}, ${formatShowDate(event.startsAt)}, is live. Post about it from the event page.`,
  };
}

export function showRescheduledNote(eventId: string, event: EventDoc, newStartsAt: number): Note {
  return {
    kind: "show_rescheduled", refId: eventId, title: "Show rescheduled",
    body: `${billing(event)} at ${venue(event)} moved to ${formatShowDate(newStartsAt)}.`,
  };
}

export function newMusicNote(profileId: string, artistName: string, trackTitle: string): Note {
  return {
    kind: "new_music", refId: profileId, title: `New from ${artistName}`,
    body: `"${trackTitle}" is up. Tap to listen.`,
  };
}
