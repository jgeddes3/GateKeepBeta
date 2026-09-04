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
// straight past. The obligations are therefore read BEFORE the cascade
// removes the evidence, and anything found, plus a sole-admin profile the
// cascade just orphaned, is escalated as one row an operator can work.
// Until the "Delete account" user action is disabled in the Identity
// Platform console (README "Manual follow-ups", and the owner-owed table in
// docs/superpowers/HANDOFF.md), this alert is the only backstop.
export const onUserDeleted = functionsV1.auth.user().onDelete(async (user) => {
  const now = Date.now();
  // Tolerated, never fatal: a read failure here must not stop the cascade,
  // which is the part that actually has to happen.
  const reasons = await listOutstandingObligations(getFirestore(), user.uid, now)
    .catch((e) => {
      console.error("onUserDeleted: could not read outstanding obligations", { uid: user.uid }, e);
      return [] as string[];
    });
  const { soleAdminOf } = await cascadeDeleteUser(user.uid, { allowSoleAdmin: true });
  if (reasons.length === 0 && soleAdminOf.length === 0) return;

  const detail = `account ${user.uid} was deleted through the Auth client SDK or console; `
    + `tickets, transfers, orders, or a sole-admin profile need manual follow-up. `
    + `Outstanding at deletion: ${reasons.length > 0 ? reasons.join(" ") : "none"}. `
    + `Profiles left with no admin: ${soleAdminOf.length > 0 ? soleAdminOf.join(", ") : "none"}.`;
  const alertId = accountDeletedUncleanAlertId(user.uid);
  await recordAdminAlert({ alertId, kind: "account_deleted_unclean", detail, bookingId: null, gigId: null, now })
    .catch((e) => console.error("onUserDeleted: could not record the unclean-deletion alert", { uid: user.uid }, e));
  console.error("onUserDeleted: unclean deletion", { uid: user.uid, reasons, soleAdminOf, alertId });
});

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
