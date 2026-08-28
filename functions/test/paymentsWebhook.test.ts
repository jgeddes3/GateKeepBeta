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
  it("a handler that throws returns 500, leaves processed:false, and marks failedAt + attempts:1 (no delete — the audit row survives)", async () => {
    const evt = fakeEvent("gatekeep.test.throw", {});
    const res = await post(evt);
    expect(res.status).toBe(500);
    const doc = await adb.doc(`stripeEvents/${evt.id}`).get();
    expect(doc.exists).toBe(true);
    const data = doc.data();
    expect(data?.processed).toBe(false);
    expect(data?.failedAt).toBeTypeOf("number");
    expect(data?.attempts).toBe(1);
  });

  it("redelivery of a FAILED event (failedAt set) re-processes IMMEDIATELY — no waiting out STALE_CLAIM_MS — another 500, attempts incremented, firstReceivedAt preserved", async () => {
    const evt = fakeEvent("gatekeep.test.throw", {});
    expect((await post(evt)).status).toBe(500);
    const first = (await adb.doc(`stripeEvents/${evt.id}`).get()).data();
    expect(first?.failedAt).toBeTypeOf("number");

    const redelivery = await post(evt);
    // Immediate re-claim: the throw handler ran again (another 500), NOT the
    // "duplicate" 200 a still-fresh in-flight claim would get.
    expect(redelivery.status).toBe(500);
    expect(redelivery.text).not.toBe("duplicate");
    const second = (await adb.doc(`stripeEvents/${evt.id}`).get()).data();
    expect(second?.attempts).toBe(2);
    expect(second?.firstReceivedAt).toBe(first?.firstReceivedAt); // carried through the re-claim
    expect(second?.receivedAt).toBeGreaterThanOrEqual(first?.receivedAt);
  });

  it("a genuinely in-flight claim (processed:false, failedAt:null, fresh receivedAt) is a duplicate, not reprocessed", async () => {
    const evt = fakeEvent("some.unknown.type", {}); // handler is never reached on the duplicate path
    await adb.doc(`stripeEvents/${evt.id}`).set({
      type: evt.type, receivedAt: Date.now(), processed: false, failedAt: null,
      firstReceivedAt: Date.now(), attempts: 1, expireAt: Date.now() + 60_000,
    });
    const res = await post(evt);
    expect(res.status).toBe(200);
    expect(res.text).toBe("duplicate");
  });

  it("an in-flight claim gone STALE (receivedAt older than STALE_CLAIM_MS, no failedAt — an unknown death) re-claims and reprocesses", async () => {
    const evt = fakeEvent("gatekeep.test.throw", {});
    const staleReceivedAt = Date.now() - STALE_CLAIM_MS - 1000;
    // Seed directly via admin SDK (not by actually failing a delivery first)
    // so this isolates the STALE branch from the KNOWN-failure branch above
    // — a real failed delivery would set failedAt itself and re-claim
    // immediately regardless of staleness.
    await adb.doc(`stripeEvents/${evt.id}`).set({
      type: evt.type, receivedAt: staleReceivedAt, processed: false, failedAt: null,
      firstReceivedAt: staleReceivedAt, attempts: 1, expireAt: Date.now() + 60_000,
    });
    const res = await post(evt);
    expect(res.status).toBe(500); // reprocessed: the throw handler ran
    expect(res.text).not.toBe("duplicate");
    const doc = await adb.doc(`stripeEvents/${evt.id}`).get();
    expect(doc.data()?.receivedAt).toBeGreaterThan(staleReceivedAt);
    expect(doc.data()?.attempts).toBe(2);
  });
});
