import { httpsCallable, FunctionsError, type HttpsCallableResult } from "firebase/functions";
import { EMAIL_NOT_VERIFIED_MESSAGE } from "@gatekeep/shared";
import { getFirebase } from "./firebase";

// One door for every callable on this client (Task 27). Same return shape as
// httpsCallable(...)(data), so `const { data } = await callFn(...)` and
// `res.data` call sites read exactly as before the codemod rewrote them.
//
// The one behavior added: a stale email_verified claim. Every sensitive
// callable runs requireVerifiedEmail (functions/src/guards.ts), which reads
// the ID token's claim; the client's cached token only rotates hourly, so a
// user who clicked the verification link a minute ago still sends a token
// that says unverified (sp1 audit finding 5). When the server answers
// failed-precondition with exactly EMAIL_NOT_VERIFIED_MESSAGE, force a token
// refresh and retry once. Any other error, and the retry's own error, are
// rethrown untouched so every existing catch branch (=== on shared messages,
// FunctionsError.details on the scanner, GatePrompt's message matching)
// keeps working.
export function isStaleVerificationError(e: unknown): boolean {
  return e instanceof FunctionsError
    && e.code === "functions/failed-precondition"
    && e.message === EMAIL_NOT_VERIFIED_MESSAGE;
}

export async function callFn<Req = unknown, Res = unknown>(name: string, data: Req): Promise<HttpsCallableResult<Res>> {
  const { functions, auth } = getFirebase();
  const fn = httpsCallable<Req, Res>(functions, name);
  try {
    return await fn(data);
  } catch (e) {
    if (!isStaleVerificationError(e) || !auth.currentUser) throw e;
    // Task 27 review: reload() first. It re-reads the ACCOUNT record, which is
    // where emailVerified actually lives; the ID token is a cached copy that
    // only rotates hourly. If the account still says unverified, the server
    // was right, so the original error is rethrown untouched and the screen's
    // existing "verify your email" branch runs exactly as before. Only a
    // genuinely stale claim gets the forced refresh and the one retry, so an
    // unverified user hammering a gated action no longer mints a fresh token
    // (and a second callable round trip) on every attempt.
    //
    // Fix round 2: reload() is a network call, and offline it throws its own
    // auth/network-request-failed. That error says nothing about verification,
    // so every screen keyed off EMAIL_NOT_VERIFIED_MESSAGE would fall through
    // to a generic failure. Rethrow the ORIGINAL error instead: the server's
    // answer is still the best thing we know.
    try {
      await auth.currentUser.reload();
    } catch {
      throw e;
    }
    if (!auth.currentUser.emailVerified) throw e;
    await auth.currentUser.getIdToken(true);
    return await fn(data);
  }
}
