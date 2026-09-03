import type { NotificationKind } from "./types.js";

export type NotificationPlatform = "web" | "mobile";

// Both the web/mobile inbox renderers and the mobile push tap handler call
// this so a notification row's deep link is computed in exactly one place.
//
// Controller ruling: the three event kinds (show_announced, show_rescheduled,
// show_post) route to the event page when a refId is present, null without
// one. new_music always returns null: its refId is the artist's profileId,
// and the clients resolve that to a handle themselves before linking, rather
// than this shared helper hard-coding a profile URL shape per platform.
export function notificationHref(
  kind: NotificationKind,
  refId: string | null | undefined,
  platform: NotificationPlatform,
): string | null {
  if (kind === "booking") return refId ? (platform === "web" ? `/dashboard/bookings/${refId}` : `/booking/${refId}`) : null;
  if (kind === "ticket") return platform === "web" ? "/tickets" : "/(fan)/tickets";
  if (kind === "show_announced" || kind === "show_rescheduled" || kind === "show_post") {
    return refId ? (platform === "web" ? `/e/${refId}` : `/event/${refId}`) : null;
  }
  if (kind === "new_music") return null;
  return null;
}
