import { signUpTestUser } from "./helpers";
import { adb } from "./discoverFixtures";
import type { MemberStripeDoc } from "@gatekeep/shared";

// SP5c Task 3 controller ruling: shared across the payout-splits test files
// (Task 3's payoutShares.test.ts, and later tasks per the same ruling), not
// exported from a test file. Adds `prefix`-`Date.now()`@test.com as a
// profile member directly via the admin SDK (skipping the invite/accept
// flow, which is not what these tests are exercising).
export async function addMember(profileId: string, prefix: string, role: "admin" | "member" = "member") {
  const u = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  await adb.doc(`profiles/${profileId}/members/${u.uid}`).set({ uid: u.uid, role, label: "bass", joinedAt: Date.now() });
  return u;
}

// SP5c Task 4 controller ruling: shared webhook test helpers (this task's
// memberPayouts.test.ts, and later tasks per the same ruling that governs
// addMember above), not declared inline in a test file.
const WEBHOOK_URL = "http://localhost:5001/gatekeep-dev-jg/us-central1/stripeWebhook";

export function fakeEvent(type: string, object: Record<string, unknown>, id = `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`) {
  return { id, type, data: { object } };
}

export async function postWebhook(body: unknown) {
  const isConnect = typeof (body as { account?: unknown } | null)?.account === "string";
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": isConnect ? "fake:connect" : "fake" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

export const memberStripe = async (uid: string) =>
  (await adb.doc(`users/${uid}/private/stripe`).get()).data() as MemberStripeDoc | undefined;

// Flips a member's fake Express account to fully enabled and delivers the
// account.updated webhook that syncs the cached flags. Returns the webhook's
// response status rather than asserting it: a fixture must not call `expect`
// itself (controller ruling), the caller asserts 200.
export async function enableMemberAccount(uid: string): Promise<number> {
  const ms = await memberStripe(uid);
  await adb.doc(`stripeFake/state/objects/${ms!.accountId}`).set(
    { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });
  const evt = { ...fakeEvent("account.updated", { id: ms!.accountId, metadata: { uid } }), account: ms!.accountId };
  return (await postWebhook(evt)).status;
}
