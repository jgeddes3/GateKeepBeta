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
});
