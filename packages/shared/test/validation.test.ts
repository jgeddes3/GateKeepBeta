import { describe, it, expect } from "vitest";
import { validateHandle, validateProfileDraft, RESERVED_HANDLES } from "../src/index";
import type { ProfileDraftInput } from "../src/index";

describe("validateHandle", () => {
  it("accepts lowercase letters, digits, underscores, 3-30 chars", () => {
    expect(validateHandle("midnight_owls9")).toEqual({ ok: true });
  });
  it("rejects reserved handles", () => {
    expect(validateHandle("admin").ok).toBe(false);
    expect(RESERVED_HANDLES).toContain("gatekeep");
  });
  it("rejects uppercase, spaces, symbols, short, long", () => {
    for (const bad of ["Ab", "has space", "sym!bol", "ab", "a".repeat(31)]) {
      expect(validateHandle(bad).ok).toBe(false);
    }
  });
  it("rejects non-string input at runtime, even though Array.includes would not coerce it", () => {
    // Untrusted onCall payloads aren't guaranteed to match the compile-time
    // type, so simulate a malicious/malformed caller with a type assertion.
    expect(validateHandle(["admin"] as unknown as string).ok).toBe(false);
    expect(validateHandle(123 as unknown as string).ok).toBe(false);
    expect(validateHandle(null as unknown as string).ok).toBe(false);
    expect(validateHandle(undefined as unknown as string).ok).toBe(false);
  });
});

describe("validateProfileDraft", () => {
  it("accepts a valid musician band draft", () => {
    expect(
      validateProfileDraft({ type: "musician", subtype: "band", name: "The Midnight Owls", handle: "midnight_owls" })
    ).toEqual({ ok: true });
  });
  it("rejects subtype not belonging to type", () => {
    expect(validateProfileDraft({ type: "musician", subtype: "venue", name: "X", handle: "xxx" }).ok).toBe(false);
  });
  it("rejects empty or >80 char names", () => {
    expect(validateProfileDraft({ type: "curator", subtype: "venue", name: "", handle: "abc" }).ok).toBe(false);
    expect(validateProfileDraft({ type: "curator", subtype: "venue", name: "a".repeat(81), handle: "abc" }).ok).toBe(false);
  });
  it("rejects non-string fields at runtime (untrusted onCall payload shapes)", () => {
    expect(
      validateProfileDraft({ type: ["musician"], subtype: "band", name: "X", handle: "xxx" } as unknown as ProfileDraftInput).ok
    ).toBe(false);
    expect(
      validateProfileDraft({ type: "musician", subtype: 5, name: "X", handle: "xxx" } as unknown as ProfileDraftInput).ok
    ).toBe(false);
    expect(
      validateProfileDraft({ type: "musician", subtype: "band", name: null, handle: "xxx" } as unknown as ProfileDraftInput).ok
    ).toBe(false);
    expect(
      validateProfileDraft({ type: "musician", subtype: "band", name: "X", handle: 123 } as unknown as ProfileDraftInput).ok
    ).toBe(false);
  });
});
