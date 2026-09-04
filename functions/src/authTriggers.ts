import * as functionsV1 from "firebase-functions/v1";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import type { UserDoc } from "@gatekeep/shared";
import { cascadeDeleteUser, listOutstandingObligations } from "./account.js";
import { accountDeletedUncleanAlertId, recordAdminAlert } from "./paymentsCore.js";

// v1 API: auth onCreate has no v2 equivalent yet.
export const onUserCreated = functionsV1.auth.user().onCreate(async (user) => {
  // Rules audit: `??` alone let an EMPTY-STRING auth displayName through, and
  // firestore.rules now requires a present, non-blank displayName on every
  // users/{uid} update (even a homeCity-only one), so such a doc would be
  // permanently unpatchable by its own owner. `||` on the trimmed value falls
  // through "" the same way it falls through undefined.
  const raw = user.displayName?.trim();
  const displayName = raw || user.email?.split("@")[0] || "New user";
  const docData: UserDoc = {
    displayName,
    // Task 8: seeded correctly at creation time, in the same write as
    // displayName, there is never a window where the doc exists with a
    // missing/stale displayNameLower for onUserDocWritten below to catch.
    displayNameLower: displayName.toLowerCase(),
    email: user.email ?? "",
    photoUrl: user.photoURL ?? null,
    homeCity: null,
    createdAt: Date.now(),
  };
  await getFirestore().doc(`users/${user.uid}`).set(docData);
});

// SP10 Task 14 (cross #3): the console and the Admin SDK are a second
// deletion path; without this only deleteAccount cascaded. Nothing here can
// refuse: the auth user is already gone. A thrown phase error is rethrown so
// the trigger's own retry policy re-runs the idempotent cascade.
//
// Branch audit (MEDIUM): `currentUser.delete()` on either client is a THIRD
// path, and Firebase offers no blocking delete trigger, so deleteAccount's
// refusals (live tickets, offered transfers, pending orders) can be walked
// straight past. The obligations are therefore read AND alerted on BEFORE the
// cascade removes the evidence, and a sole-admin profile the cascade just
// orphaned folds into the same row an operator can work.
// Until the "Delete account" user action is disabled in the Identity
// Platform console (README "Manual follow-ups", and the owner-owed table in
// docs/superpowers/HANDOFF.md), this alert is the only backstop.
export const onUserDeleted = functionsV1.auth.user().onDelete((user) => handleUserDeleted(user.uid, {
  now: Date.now(),
  listObligations: (uid, now) => listOutstandingObligations(getFirestore(), uid, now),
  cascade: (uid) => cascadeDeleteUser(uid, { allowSoleAdmin: true }),
  recordAlert: (a) => recordAdminAlert({
    alertId: a.alertId, kind: "account_deleted_unclean", detail: a.detail,
    bookingId: null, gigId: null, now: a.now,
  }),
}));

// The seam the trigger above is a one-line wrapper around. Everything it
// touches arrives as a dependency so the ORDER of the two writes (alert, then
// cascade) is testable without an emulator: once the cascade has run there is
// no evidence left to re-derive, and the ordering is the whole point of the
// fix, not an implementation detail.
export interface UserDeletedDeps {
  now: number;
  listObligations: (uid: string, now: number) => Promise<string[]>;
  cascade: (uid: string) => Promise<{ soleAdminOf: string[] }>;
  recordAlert: (a: { alertId: string; detail: string; now: number }) => Promise<unknown>;
}

// `soleAdminOf` is null while the answer is still unknown: the alert written
// before the cascade cannot claim "none", it has not been asked yet.
function soleAdminPhrase(soleAdminOf: string[] | null): string {
  if (soleAdminOf === null) return "not known yet, the cascade had not run";
  return soleAdminOf.length > 0 ? soleAdminOf.join(", ") : "none";
}

function uncleanDetail(uid: string, reasons: string[], soleAdminOf: string[] | null): string {
  return `account ${uid} was deleted through the Auth client SDK or console; `
    + `tickets, transfers, orders, or a sole-admin profile need manual follow-up. `
    + `Outstanding at deletion: ${reasons.length > 0 ? reasons.join(" ") : "none"}. `
    + `Profiles left with no admin: ${soleAdminPhrase(soleAdminOf)}.`;
}

export async function handleUserDeleted(uid: string, deps: UserDeletedDeps): Promise<void> {
  const { now } = deps;
  // Tolerated, never fatal: a read failure here must not stop the cascade,
  // which is the part that actually has to happen.
  const reasons = await deps.listObligations(uid, now)
    .catch((e) => {
      console.error("onUserDeleted: could not read outstanding obligations", { uid }, e);
      return [] as string[];
    });
  const alertId = accountDeletedUncleanAlertId(uid);
  const record = (detail: string) => deps.recordAlert({ alertId, detail, now })
    .catch((e) => console.error("onUserDeleted: could not record the unclean-deletion alert", { uid }, e));

  // Fix round 2 (item 1): the obligations are already known here, and the
  // cascade is the thing that destroys the evidence behind them. A phase that
  // throws hands the trigger's retry policy an idempotent re-run, but until
  // that re-run succeeds nothing would record that this deletion was unclean,
  // so the row goes down FIRST. The sole-admin half is not knowable yet (only
  // the cascade reports it), which is what the "not known yet" clause says.
  if (reasons.length > 0) {
    await record(uncleanDetail(uid, reasons, null));
    console.error("onUserDeleted: unclean deletion", { uid, reasons, alertId });
  }

  let soleAdminOf: string[] = [];
  let cascadeError: unknown = null;
  try {
    ({ soleAdminOf } = await deps.cascade(uid));
  } catch (e) {
    cascadeError = e;
  }
  try {
    // The one fact only the cascade can report. The upsert re-stamps the
    // detail, so a row written above now names the orphaned profiles too.
    if (soleAdminOf.length > 0) {
      await record(uncleanDetail(uid, reasons, soleAdminOf));
      console.error("onUserDeleted: unclean deletion", { uid, reasons, soleAdminOf, alertId });
    }
  } finally {
    // A CascadePhaseError still has to escape (the trigger's retry policy
    // re-runs the idempotent cascade), but only AFTER the alert attempt above,
    // never instead of it.
    if (cascadeError !== null) throw cascadeError;
  }
}

// Task 8: the single consistency rule for users/{uid}.displayNameLower,
// "what should it be, given the doc's current displayName, and does it need
// writing?" Returns null when already consistent (nothing to write), or the
// corrected lowercase value otherwise. Shared by the onUserDocWritten
// trigger below AND adminTools.ts's backfillDisplayNameLower (its bulk-scan
// sibling for pre-existing/legacy docs this trigger never had a chance to
// react to).
//
// Exported as a pure function specifically so it has a deterministic,
// emulator-free unit-test seam: this trigger reacts to EVERY write to
// users/{uid}, so a test that seeds an "inconsistent" doc directly against a
// live emulator gets it corrected within single-digit milliseconds, almost
// always before a separate integration test (let alone a bulk backfill scan,
// whose own collection-wide query takes far longer) could ever observe it
// still inconsistent. The decision rule itself is what's reliably testable.
export function computeDisplayNameLowerFix(
  data: { displayName?: unknown; displayNameLower?: unknown } | undefined,
): string | null {
  const displayName = typeof data?.displayName === "string" ? data.displayName : "";
  const expectedLower = displayName.toLowerCase();
  return data?.displayNameLower === expectedLower ? null : expectedLower;
}

// Keeps users/{uid}.displayNameLower in sync whenever displayName changes
// after creation (e.g. the owner's own client update, which firestore.rules
// permits directly on displayName). displayNameLower itself is NOT
// client-writable (outside the users update rule's hasOnly set), so the only
// way it can drift is via this trigger falling behind, and the only way to
// bring it back in sync is this trigger's own write.
//
// That self-write is exactly why the no-op guard (computeDisplayNameLowerFix
// returning null) is load-bearing: this trigger fires on EVERY write to
// users/{uid}, including the one it just made. Without first checking "is
// displayNameLower already correct?" before writing, every sync write would
// immediately re-trigger itself, an infinite retrigger loop. The guard
// makes the handler a fixed point: once displayNameLower == lower(displayName),
// further invocations (including the one caused by its own prior write) see
// nothing to do and return.
export const onUserDocWritten = onDocumentWritten("users/{uid}", async (event) => {
  const after = event.data?.after;
  if (!after?.exists) return; // deleted (or no after-state), nothing to sync
  const fix = computeDisplayNameLowerFix(after.data() as UserDoc | undefined);
  if (fix === null) return;
  await after.ref.update({ displayNameLower: fix });
});
