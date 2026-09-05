import { describe, it, expect } from "vitest";
import { notificationHref } from "../src/index.js";

describe("notificationHref", () => {
  it("routes booking rows to the thread on each platform", () => {
    expect(notificationHref("booking", "b1", "web")).toBe("/dashboard/bookings/b1");
    expect(notificationHref("booking", "b1", "mobile")).toBe("/booking/b1");
  });
  it("routes ticket rows to the wallet regardless of refId", () => {
    expect(notificationHref("ticket", "e1", "web")).toBe("/tickets");
    expect(notificationHref("ticket", null, "mobile")).toBe("/(fan)/tickets");
  });
  it("returns null for kinds with no destination and for booking rows without a refId", () => {
    expect(notificationHref("system", null, "web")).toBeNull();
    expect(notificationHref("booking", undefined, "mobile")).toBeNull();
  });
  it("routes event kinds (show_announced, show_rescheduled, show_post) to the event page on each platform, and null without a refId", () => {
    expect(notificationHref("show_announced", "e1", "web")).toBe("/e/e1");
    expect(notificationHref("show_announced", "e1", "mobile")).toBe("/event/e1");
    expect(notificationHref("show_rescheduled", "e2", "web")).toBe("/e/e2");
    expect(notificationHref("show_rescheduled", "e2", "mobile")).toBe("/event/e2");
    expect(notificationHref("show_post", "e3", "web")).toBe("/e/e3");
    expect(notificationHref("show_post", "e3", "mobile")).toBe("/event/e3");
    expect(notificationHref("show_announced", null, "web")).toBeNull();
    expect(notificationHref("show_post", undefined, "mobile")).toBeNull();
  });
  it("returns null for new_music (clients resolve its profileId to a handle themselves)", () => {
    expect(notificationHref("new_music", "p1", "web")).toBeNull();
    expect(notificationHref("new_music", null, "mobile")).toBeNull();
  });
  it("routes saved_search_match to the event page when refKind is event", () => {
    expect(notificationHref("saved_search_match", "e1", "web", "event")).toBe("/e/e1");
    expect(notificationHref("saved_search_match", "e1", "mobile", "event")).toBe("/event/e1");
  });
  it("routes saved_search_match to gigs when refKind is gig", () => {
    expect(notificationHref("saved_search_match", "g1", "web", "gig")).toBe("/gigs/g1");
    expect(notificationHref("saved_search_match", "g1", "mobile", "gig")).toBe("/(musician)/gigs?gigId=g1");
  });
  it("returns null for saved_search_match with refKind profile, or with no refId (clients resolve the handle themselves)", () => {
    expect(notificationHref("saved_search_match", "p1", "web", "profile")).toBeNull();
    expect(notificationHref("saved_search_match", "p1", "mobile", "profile")).toBeNull();
    expect(notificationHref("saved_search_match", null, "web", "event")).toBeNull();
    expect(notificationHref("saved_search_match", undefined, "mobile", "gig")).toBeNull();
  });
  it("routes payout kinds to the payouts surface", () => {
    for (const kind of ["share_paid", "share_held", "share_released", "member_payout_failed"] as const) {
      expect(notificationHref(kind, null, "web", "payouts")).toBe("/dashboard#payouts");
      expect(notificationHref(kind, null, "mobile", "payouts")).toBe("/(fan)/payouts");
    }
  });
  it("routes artist_tag to the event page on both platforms", () => {
    expect(notificationHref("artist_tag", "ev1", "web")).toBe("/e/ev1");
    expect(notificationHref("artist_tag", "ev1", "mobile")).toBe("/event/ev1");
    expect(notificationHref("artist_tag", null, "web")).toBeNull();
  });
});
