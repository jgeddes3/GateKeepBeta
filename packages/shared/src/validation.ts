import type { ProfileDraftInput } from "./types.js";

export const RESERVED_HANDLES = [
  "admin", "gatekeep", "support", "help", "api", "www",
] as const;

const HANDLE_RE = /^[a-z0-9_]{3,30}$/;

export function validateHandle(handle: string): { ok: true } | { ok: false; reason: string } {
  // Defensive runtime guard: the compile-time `string` type only binds
  // trusted callers — an onCall's generic type parameter does not validate
  // the untrusted request payload at runtime, so `handle` can arrive as any
  // JSON value. RESERVED_HANDLES.includes() does not coerce, so a non-string
  // (e.g. an array or number) would otherwise sail past the reserved check.
  if (typeof handle !== "string") {
    return { ok: false, reason: "Handle must be a string." };
  }
  if (!HANDLE_RE.test(handle)) {
    return { ok: false, reason: "Handles are 3-30 lowercase letters, digits, or underscores." };
  }
  if ((RESERVED_HANDLES as readonly string[]).includes(handle)) {
    return { ok: false, reason: "That handle is reserved." };
  }
  return { ok: true };
}

const SUBTYPES: Record<string, string[]> = {
  musician: ["solo", "band"],
  curator: ["venue", "planner", "individual_host"],
};

export function validateProfileDraft(input: ProfileDraftInput): { ok: true } | { ok: false; reason: string } {
  // Same defensive rationale as validateHandle above: input.type/subtype/name
  // are typed as string at compile time, but this is untrusted onCall
  // payload data at runtime and can arrive as any JSON shape.
  if (
    typeof input.type !== "string" ||
    typeof input.subtype !== "string" ||
    typeof input.name !== "string" ||
    typeof input.handle !== "string"
  ) {
    return { ok: false, reason: "Invalid profile draft input." };
  }
  if (!SUBTYPES[input.type]?.includes(input.subtype)) {
    return { ok: false, reason: "Invalid profile type/subtype." };
  }
  if (input.name.trim().length < 1 || input.name.length > 80) {
    return { ok: false, reason: "Name must be 1-80 characters." };
  }
  return validateHandle(input.handle);
}
