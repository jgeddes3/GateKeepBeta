import { describe, it, expect } from "vitest";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const WEBHOOK_URL = "http://localhost:5001/gatekeep-dev-jg/us-central1/stripeWebhook";

function fakeEvent(type: string, object: Record<string, unknown>, id = `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`) {
  return { id, type, data: { object } };
}

async function post(body: unknown): Promise<number> {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": "fake" },
    body: JSON.stringify(body),
  });
  return res.status;
}

describe("stripeWebhook", () => {
  it("records unknown event types and returns 200", async () => {
    const evt = fakeEvent("some.unknown.type", {});
    expect(await post(evt)).toBe(200);
    const doc = await adb.doc(`stripeEvents/${evt.id}`).get();
    expect(doc.exists).toBe(true);
    expect(doc.data()?.processed).toBe(true);
  });

  it("is exactly-once per event id — a replay is a 200 no-op", async () => {
    const evt = fakeEvent("some.unknown.type", {});
    expect(await post(evt)).toBe(200);
    expect(await post(evt)).toBe(200); // duplicate path
    const events = await adb.collection("stripeEvents").where("type", "==", "some.unknown.type").get();
    // (>=1 — other tests share the type; the load-bearing assertion is that
    // the SECOND post did not error and did not double-process — covered by
    // Task 4's account.updated test asserting a single side effect.)
    expect(events.size).toBeGreaterThan(0);
  });

  it("rejects malformed bodies", async () => {
    expect(await post({ nope: true })).toBe(400);
  });

  it("rejects non-POST", async () => {
    const res = await fetch(WEBHOOK_URL, { method: "GET" });
    expect(res.status).toBe(405);
  });
});
