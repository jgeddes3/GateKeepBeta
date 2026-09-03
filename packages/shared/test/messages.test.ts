import { describe, it, expect } from "vitest";
import * as shared from "../src/index.js";

describe("shared message constants", () => {
  it("every exported *_MESSAGE and *_LINE string is em-dash free", () => {
    const offenders = Object.entries(shared)
      .filter(([k, v]) => typeof v === "string" && /_(MESSAGE|LINE)$/.test(k) && v.includes("\u2014"))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });
  it("exports the sub-project 10 constants", () => {
    expect(shared.THREAD_FULL_MESSAGE).toBe("Thread is full: accept, decline or withdraw.");
    expect(shared.CHECK_IN_OPENS_BEFORE_MS).toBe(43_200_000);
    expect(shared.PENDING_ORDERS_PER_USER_CAP).toBe(3);
  });
});
