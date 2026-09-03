import * as functionsV1 from "firebase-functions/v1";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import type { UserDoc } from "@gatekeep/shared";

// v1 API: auth onCreate has no v2 equivalent yet.
export const onUserCreated = functionsV1.auth.user().onCreate(async (user) => {
  const displayName = user.displayName ?? user.email?.split("@")[0] ?? "New user";
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
