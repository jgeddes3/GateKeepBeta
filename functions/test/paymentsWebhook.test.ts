import { describe, it, expect } from "vitest";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { STALE_CLAIM_MS } from "../src/paymentsWebhook.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const WEBHOOK_URL = "http://localhost:5001/gatekeep-dev-jg/us-central1/stripeWebhook";

function fakeEvent(type: string, object: Record<string, unknown>, id = `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`) {
  return { id, type, data: { object } };
}

async function post(body: unknown, headers: Record<string, string> = { "stripe-signature": "fake" }): Promise<{ status: number; text: string }> {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

describe("stripeWebhook", () => {
  it("records unknown event types and returns 200", async () => {
    const evt = fakeEvent("some.unknown.type", {});
    expect((await post(evt)).status).toBe(200);
    const doc = await adb.doc(`stripeEvents/${evt.id}`).get();
    expect(doc.exists).toBe(true);
    expect(doc.data()?.processed).toBe(true);
  });

  it("is exactly-once per event id — a replay is a 200 \"duplicate\" no-op, and receivedAt is unchanged", async () => {
    const evt = fakeEvent("some.unknown.type", {});
    expect((await post(evt)).status).toBe(200);
    const firstReceivedAt = (await adb.doc(`stripeEvents/${evt.id}`).get()).data()?.receivedAt;
    const replay = await post(evt);
    expect(replay.status).toBe(200);
    expect(replay.text).toBe("duplicate");
    const secondReceivedAt = (await adb.doc(`stripeEvents/${evt.id}`).get()).data()?.receivedAt;
    expect(secondReceivedAt).toBe(firstReceivedAt);
  });

  it("rejects malformed bodies", async () => {
    expect((await post({ nope: true })).status).toBe(400);
  });

  it("rejects an event.id that isn't a valid doc id (closes doc-id path injection via the fake's JSON.parse)", async () => {
    expect((await post(fakeEvent("some.unknown.type", {}, "a/b"))).status).toBe(400);
  });

  it("rejects a request missing the stripe-signature header", async () => {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fakeEvent("some.unknown.type", {})),
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-POST", async () => {
    const res = await fetch(WEBHOOK_URL, { method: "GET" });
    expect(res.status).toBe(405);
  });

  // gatekeep.test.throw / gatekeep.test.ok are registered only when
  // FUNCTIONS_EMULATOR === "true" (see paymentsWebhook.ts) — the functions
  // emulator this suite runs against sets that itself.
  it("a handler that throws returns 500 and leaves the claim processed:false (no delete — the audit row survives)", async () => {
    const evt = fakeEvent("gatekeep.test.throw", {});
    const res = await post(evt);
    expect(res.status).toBe(500);
    const doc = await adb.doc(`stripeEvents/${evt.id}`).get();
    expect(doc.exists).toBe(true);
    expect(doc.data()?.processed).toBe(false);
  });

  it("a second delivery of the SAME failed event id within STALE_CLAIM_MS is a duplicate, not reprocessed", async () => {
    const evt = fakeEvent("gatekeep.test.throw", {});
    expect((await post(evt)).status).toBe(500);
    const replay = await post(evt);
    expect(replay.status).toBe(200);
    expect(replay.text).toBe("duplicate");
  });

  it("a delivery after the claim goes stale re-claims (fresh receivedAt) and reprocesses — the throw handler fires again", async () => {
    const evt = fakeEvent("gatekeep.test.throw", {});
    expect((await post(evt)).status).toBe(500);
    // Force the claim stale via an admin-SDK rewrite of receivedAt instead of
    // actually waiting out STALE_CLAIM_MS in a test.
    const staleReceivedAt = Date.now() - STALE_CLAIM_MS - 1000;
    await adb.doc(`stripeEvents/${evt.id}`).update({ receivedAt: staleReceivedAt });
    const reprocessed = await post(evt);
    // Reprocessed (not a "duplicate" 200): the throw handler ran again.
    expect(reprocessed.status).toBe(500);
    expect(reprocessed.text).not.toBe("duplicate");
    const doc = await adb.doc(`stripeEvents/${evt.id}`).get();
    expect(doc.data()?.receivedAt).toBeGreaterThan(staleReceivedAt);
  });
});
