import { describe, it, expect, vi } from "vitest";
import { callFn } from "./helpers";
import { adb, makeFan, makePublishedBookingEvent, waitForIndex } from "./discoverFixtures";
import { SAVED_SEARCH_LIMIT, type SavedSearchDoc, type NotificationDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 40_000 });

async function waitForNotifications(uid: string, ok: (n: NotificationDoc[]) => boolean, ms = 15_000): Promise<NotificationDoc[]> {
  const until = Date.now() + ms;
  for (;;) {
    const snap = await adb.collection(`users/${uid}/notifications`).where("kind", "==", "saved_search_match").get();
    const list = snap.docs.map((d) => d.data() as NotificationDoc);
    if (ok(list)) return list;
    if (Date.now() > until) return list;
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe("saveSearch / deleteSavedSearch", () => {
  it("saves with a server-built label, collapses duplicates, enforces the cap, and deletes owner-only", async () => {
    const fan = await makeFan("ss1");
    const { id } = await callFn<object, { id: string }>("saveSearch", { face: "fan", q: "owls", filters: { when: "weekend", nearMe: true } }, fan.user);
    const saved = (await adb.doc(`savedSearches/${id}`).get()).data() as SavedSearchDoc;
    expect(saved).toMatchObject({ uid: fan.uid, face: "fan", kind: "show", q: "owls", label: "\"owls\" · This weekend", lastMatchedAt: null });
    expect(saved.filters.nearMe).toBe(false);
    const again = await callFn<object, { id: string }>("saveSearch", { face: "fan", q: " Owls ", filters: { when: "weekend" } }, fan.user);
    expect(again.id).toBe(id);
    await expect(callFn("saveSearch", { face: "fan", q: "", filters: { nearMe: true } }, fan.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
    for (let i = 1; i < SAVED_SEARCH_LIMIT; i++) {
      await adb.collection("savedSearches").add({ uid: fan.uid, face: "fan", kind: "show", q: `q${i}`, filters: {}, label: `"q${i}"`, createdAt: Date.now(), lastMatchedAt: null });
    }
    await expect(callFn("saveSearch", { face: "fan", q: "one more", filters: {} }, fan.user)).rejects.toMatchObject({ code: "functions/failed-precondition" });
    const other = await makeFan("ss1o");
    await expect(callFn("deleteSavedSearch", { id }, other.user)).rejects.toMatchObject({ code: "functions/not-found" });
    await callFn("deleteSavedSearch", { id }, fan.user);
    expect((await adb.doc(`savedSearches/${id}`).get()).exists).toBe(false);
  });
});

describe("saved search alerts", () => {
  it("notifies once per saved search and index doc, and not for non-matches", async () => {
    const fan = await makeFan("ss2");
    const miss = await makeFan("ss2m");
    await callFn("saveSearch", { face: "fan", q: "the act", filters: {} }, fan.user);
    await callFn("saveSearch", { face: "fan", q: "zzzqqq", filters: {} }, miss.user);
    const { eventId } = await makePublishedBookingEvent("ss2e");
    await waitForIndex(`show_${eventId}`, (x) => x !== undefined);
    const notes = await waitForNotifications(fan.uid, (n) => n.some((x) => x.refId === eventId));
    const note = notes.find((x) => x.refId === eventId)!;
    expect(note).toMatchObject({ kind: "saved_search_match", refKind: "event", title: "New match for a saved search" });
    expect(note.body).toContain("\"the act\"");
    await new Promise((r) => setTimeout(r, 2000));
    expect((await waitForNotifications(miss.uid, () => true, 1)).some((x) => x.refId === eventId)).toBe(false);
    // Re-create the index doc (a status flip and back) and expect no second notification.
    await adb.doc(`events/${eventId}`).update({ status: "draft" });
    await waitForIndex(`show_${eventId}`, (x) => x === undefined);
    await adb.doc(`events/${eventId}`).update({ status: "published" });
    await waitForIndex(`show_${eventId}`, (x) => x !== undefined);
    await new Promise((r) => setTimeout(r, 2000));
    const after = await waitForNotifications(fan.uid, () => true, 1);
    expect(after.filter((x) => x.refId === eventId)).toHaveLength(1);
    const savedSnap = await adb.collection("savedSearches").where("uid", "==", fan.uid).get();
    expect((savedSnap.docs[0].data() as SavedSearchDoc).lastMatchedAt).not.toBeNull();
  });
});
