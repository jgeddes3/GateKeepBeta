import { describe, it, expect, vi } from "vitest";
import { callFn, makeAdminUser } from "./helpers";
import { adb, makeApprovedMusicianProfile, makeApprovedCuratorProfile, makePublishedBookingEvent, makeFan, waitForIndex } from "./discoverFixtures";
import { runSearchIndexSweep } from "../src/searchIndex.js";
vi.setConfig({ testTimeout: 60_000 });

const DAY = 24 * 60 * 60 * 1000;

describe("backfillSearchIndex", () => {
  // 180s, not the file's 60s default: under the full suite this callable
  // legitimately walks every profile/event/gig the other 47 test files
  // leave in the shared emulator database, not just this test's own rows.
  it("rebuilds missing docs, is admin-only, and is idempotent", async () => {
    const m = await makeApprovedMusicianProfile("bf1m");
    const c = await makeApprovedCuratorProfile("bf1c");
    const { eventId } = await makePublishedBookingEvent("bf1e");
    await waitForIndex(`show_${eventId}`, (x) => x !== undefined);
    await adb.doc(`searchIndex/artist_${m.profileId}`).delete();
    await adb.doc(`searchIndex/venue_${c.profileId}`).delete();
    await adb.doc(`searchIndex/show_${eventId}`).delete();
    const fan = await makeFan("bf1f");
    await expect(callFn("backfillSearchIndex", {}, fan.user)).rejects.toMatchObject({ code: "functions/permission-denied" });
    const admin = await makeAdminUser("bf1a");
    const r1 = await callFn<object, { artists: number; venues: number; shows: number; gigs: number; deleted: number }>("backfillSearchIndex", {}, admin.user);
    expect(r1.artists).toBeGreaterThanOrEqual(1);
    expect(r1.venues).toBeGreaterThanOrEqual(1);
    expect(r1.shows).toBeGreaterThanOrEqual(1);
    expect((await adb.doc(`searchIndex/artist_${m.profileId}`).get()).exists).toBe(true);
    expect((await adb.doc(`searchIndex/venue_${c.profileId}`).get()).exists).toBe(true);
    expect((await adb.doc(`searchIndex/show_${eventId}`).get()).exists).toBe(true);
    const r2 = await callFn<object, { artists: number }>("backfillSearchIndex", {}, admin.user);
    expect(r2.artists).toBe(r1.artists);
  }, 180_000);
});

describe("runSearchIndexSweep", () => {
  it("deletes shows that ended more than a day ago and leaves the rest", async () => {
    const now = Date.now();
    const stale = adb.doc("searchIndex/show_sweep_stale");
    const fresh = adb.doc("searchIndex/show_sweep_fresh");
    const gig = adb.doc("searchIndex/gig_sweep_gig");
    const row = (kind: string, endsAt: number | null) => ({
      kind, sourceId: "x", handle: null, title: "T", subtitle: "", words: [], tokens: [], genres: [], city: null, cityLower: null,
      neighborhood: null, geo: null, startsAt: now - 3 * DAY, endsAt, priceFromCents: null, hasFreeTier: false, budgetMinCents: null,
      budgetMaxCents: null, actSize: null, hasAudio: false, busyDays: [], relatedProfileIds: [], followerCount: 0, imagePath: null, updatedAt: now,
    });
    await stale.set(row("show", now - 2 * DAY));
    await fresh.set(row("show", now - DAY / 2));
    await gig.set(row("gig", null));
    const deleted = await runSearchIndexSweep(adb, now);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect((await stale.get()).exists).toBe(false);
    expect((await fresh.get()).exists).toBe(true);
    expect((await gig.get()).exists).toBe(true);
  });
});
