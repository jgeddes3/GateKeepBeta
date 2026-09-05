import { describe, it, expect, vi } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import { callFn, signUpTestUser } from "./helpers";
import { adb, makeApprovedCuratorProfile, eventContent, addTiersAndPublish, waitForIndex } from "./discoverFixtures";
import type { SearchInput, SearchOutput } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 60_000 });

const FREE_TIER = [{ name: "GA", priceCents: 0, capacity: 20, saleStartsAt: null, saleEndsAt: null }];

// Unique token per run so the shared emulator database cannot flood the
// candidate cap with other suites' events (sp8-rulings.md ruling 5).
const token = `zorbulon${Date.now().toString(36)}`;

async function publishShow(profileId: string, user: Parameters<typeof addTiersAndPublish>[2], suffix: string, ageRestriction: string) {
  const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
    curatorProfileId: profileId, source: { kind: "standalone" },
    ...eventContent({ title: `${token} ${suffix}` }), ageRestriction,
  }, user);
  await addTiersAndPublish(profileId, eventId, user, FREE_TIER);
  return eventId;
}

describe("ageRestriction in the search index", () => {
  it("projects the facet and the fan face's allAges filter drops 18+ and 21+ shows", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ag1", "venue");
    const allAgesId = await publishShow(profileId, owner.user, "open", "all_ages");
    const eighteenId = await publishShow(profileId, owner.user, "gated", "18_plus");

    expect((await waitForIndex(`show_${allAgesId}`, (d) => d?.ageRestriction === "all_ages"))?.ageRestriction).toBe("all_ages");
    expect((await waitForIndex(`show_${eighteenId}`, (d) => d?.ageRestriction === "18_plus"))?.ageRestriction).toBe("18_plus");

    const fan = await signUpTestUser(`ag1f-${Date.now()}@test.com`);
    const run = (allAges: boolean) => callFn<SearchInput, SearchOutput>("search", {
      face: "fan", q: token, filters: allAges ? { allAges: true } : {}, location: null, page: 0, includePins: false,
    }, fan.user);

    const both = await run(false);
    expect(both.items.map((i) => i.id).sort()).toEqual([allAgesId, eighteenId].sort());
    const filtered = await run(true);
    expect(filtered.items.map((i) => i.id)).toEqual([allAgesId]);
  });

  it("reads a pre-SP11 event with no ageRestriction as all ages", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("ag2", "venue");
    const legacyId = await publishShow(profileId, owner.user, "legacy", "all_ages");
    // Strip the field the way a pre-SP11 doc looks, then force a re-project.
    await adb.doc(`events/${legacyId}`).update({ ageRestriction: FieldValue.delete(), updatedAt: Date.now() });
    expect((await waitForIndex(`show_${legacyId}`, (d) => d?.ageRestriction === "all_ages"))?.ageRestriction).toBe("all_ages");
  });
});
