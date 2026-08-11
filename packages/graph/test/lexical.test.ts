import { describe, expect, it } from "vitest";
import { predictFiles, CONFIDENCE_FLOOR, RUNNER_UP_MARGIN } from "../src/lexical.js";

describe("predictFiles", () => {
  it("ranks a module's files above unrelated files when criteria name that module's identifiers", () => {
    const candidates = [
      "src/auth/session.ts",
      "src/auth/login.ts",
      "src/billing/invoice.ts",
      "src/billing/ledger.ts",
      "docs/readme.md",
    ];
    // Both criteria repeat "session" and "login" — the auth module's own
    // identifiers — so the auth files clear both the floor and the margin
    // over the billing/docs files, which share no token with either.
    const criteria = [
      "the session token is validated on every login attempt",
      "an expired session invalidates the login form",
    ];

    const result = predictFiles(criteria, candidates);

    expect(result.length).toBeGreaterThan(0);
    for (const match of result) {
      expect(match.file.startsWith("src/auth/")).toBe(true);
    }
  });

  it("returns a byte-identical ranking across repeated runs, ties broken by compare", () => {
    const candidates = ["src/foo/bar.ts", "src/foo/baz.ts", "src/quux.ts"];
    // "foo" appears in two candidates with identical token overlap, so both
    // tie for the top score — the tie must resolve the same way every time,
    // through `compare`, never object/Set iteration order.
    const criteria = ["the foo module handles foo requests"];

    const first = predictFiles(criteria, candidates);
    const second = predictFiles(criteria, candidates);
    expect(second).toEqual(first);

    // "bar.ts" < "baz.ts" under `compare` (plain code-point order).
    if (first.length === 2) {
      expect(first[0]?.file).toBe("src/foo/bar.ts");
      expect(first[1]?.file).toBe("src/foo/baz.ts");
    }
  });

  it("returns no match for boilerplate criteria carrying no distinctive identifiers", () => {
    const candidates = ["src/auth/session.ts", "src/billing/invoice.ts", "src/checkout/cart.ts"];
    const criteria = ["the code is well tested", "this behaves as expected in every case"];

    expect(predictFiles(criteria, candidates)).toEqual([]);
  });

  it("returns no match against an empty candidate list, without throwing", () => {
    expect(() => predictFiles(["the auth session is valid"], [])).not.toThrow();
    expect(predictFiles(["the auth session is valid"], [])).toEqual([]);
  });

  it("returns no match for empty criteria, without throwing", () => {
    const candidates = ["src/auth/session.ts"];
    expect(() => predictFiles([], candidates)).not.toThrow();
    expect(predictFiles([], candidates)).toEqual([]);
  });

  it("exposes the calibrated floor and margin as named constants in (0, 1]", () => {
    expect(CONFIDENCE_FLOOR).toBeGreaterThan(0);
    expect(CONFIDENCE_FLOOR).toBeLessThanOrEqual(1);
    expect(RUNNER_UP_MARGIN).toBeGreaterThan(0);
    expect(RUNNER_UP_MARGIN).toBeLessThanOrEqual(1);
  });

  it("respects an explicit confidenceFloor/runnerUpMargin override", () => {
    const candidates = ["src/auth/session.ts", "src/billing/invoice.ts", "src/checkout/cart.ts"];
    // Only "session" overlaps the auth file; "invoice" and "checkout" carry
    // idf mass too (each names a DIFFERENT candidate), so the auth file
    // recovers only a THIRD of the query's total idf-weighted mass — a
    // partial, fractional match, not the trivial score-1.0 case.
    const criteria = ["the session token relates to invoice checkout flows"];

    const permissive = predictFiles(criteria, candidates, { confidenceFloor: 0.1, runnerUpMargin: 0 });
    const strict = predictFiles(criteria, candidates, { confidenceFloor: 0.9, runnerUpMargin: 0 });
    expect(permissive.length).toBeGreaterThan(0);
    expect(strict).toEqual([]);
  });
});
