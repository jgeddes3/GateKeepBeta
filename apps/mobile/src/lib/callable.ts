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
    await auth.currentUser.getIdToken(true);
    return await fn(data);
  }
}
