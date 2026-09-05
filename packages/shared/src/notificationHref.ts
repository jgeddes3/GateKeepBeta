import type { NotificationDoc, NotificationKind } from "./types.js";

export type NotificationPlatform = "web" | "mobile";

// Both the web/mobile inbox renderers and the mobile push tap handler call
// this so a notification row's deep link is computed in exactly one place.
//
// Controller ruling: the three event kinds (show_announced, show_rescheduled,
// show_post) route to the event page when a refId is present, null without
// one. new_music always returns null: its refId is the artist's profileId,
// and the clients resolve that to a handle themselves before linking, rather
// than this shared helper hard-coding a profile URL shape per platform.
// SP8: saved_search_match routes on refKind: event -> the event page, gig ->
// the gigs page, profile (or a missing refId) -> null, same as new_music,
// the clients resolve the handle themselves.
// SP5c: the four payout kinds (share_paid, share_held, share_released,
// member_payout_failed) all route to the payouts surface regardless of refId.
export function notificationHref(
  kind: NotificationKind,
  refId: string | null | undefined,
  platform: NotificationPlatform,
  refKind?: NotificationDoc["refKind"],
): string | null {
  if (kind === "booking") return refId ? (platform === "web" ? `/dashboard/bookings/${refId}` : `/booking/${refId}`) : null;
  if (kind === "ticket") return platform === "web" ? "/tickets" : "/(fan)/tickets";
  // SP11: artist_tag carries the eventId in refId and opens the event page,
  // where the tagged artist's admins see the accept and decline banner.
  if (kind === "show_announced" || kind === "show_rescheduled" || kind === "show_post" || kind === "artist_tag") {
    return refId ? (platform === "web" ? `/e/${refId}` : `/event/${refId}`) : null;
  }
  if (kind === "new_music") return null;
  if (kind === "saved_search_match") {
    if (!refId) return null;
    if (refKind === "event") return platform === "web" ? `/e/${refId}` : `/event/${refId}`;
    if (refKind === "gig") return platform === "web" ? `/gigs/${refId}` : `/(musician)/gigs?gigId=${refId}`;
    return null;
  }
  if (kind === "share_paid" || kind === "share_held" || kind === "share_released" || kind === "member_payout_failed") {
    return platform === "web" ? "/dashboard#payouts" : "/(fan)/payouts";
  }
  return null;
}
