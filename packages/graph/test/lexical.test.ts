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

    // Unconditionally, not `if (first.length === 2)`: a guarded assertion
    // passes silently the day the tie stops being a tie, which is the one
    // regression this test exists to catch.
    expect(first.map((m) => m.file)).toEqual(["src/foo/bar.ts", "src/foo/baz.ts"]);

    // The criterion is "byte-identical across runs", and a run does not
    // promise the caller assembled `candidates` in the same order — `harvest`
    // yields paths in commit order, and `own`/`conflicts` will hand this
    // whatever order they built. Ranking must come out of `compare` and the
    // score alone, never out of input position, so a reversed corpus is the
    // same answer.
    const reversed = predictFiles(criteria, [...candidates].reverse());
    expect(reversed).toEqual(first);
  });

  it("returns no match for boilerplate criteria carrying no distinctive identifiers", () => {
    const candidates = ["src/auth/session.ts", "src/billing/invoice.ts", "src/checkout/cart.ts"];
    const criteria = ["the code is well tested", "this behaves as expected in every case"];

    expect(predictFiles(criteria, candidates)).toEqual([]);
  });

  it("never answers with a zero-score candidate, however permissive the configured floor", () => {
    const candidates = ["src/auth/session.ts", "src/billing/invoice.ts", "src/checkout/cart.ts"];
    const criteria = ["the code is well tested", "this behaves as expected in every case"];

    // `lexicalConfidenceFloor: 0` is the natural spelling of "no floor, show
    // me everything you have", and it is settable from octograph.yaml (see
    // config.test.ts). Before the `top <= 0` guard it returned EVERY candidate
    // in the corpus — each with `score: 0`, i.e. sharing not one distinctive
    // token with the criteria — as a `predicted` attribution: the arbitrary
    // top-N this module's fourth acceptance criterion forbids, in its worst
    // form. A zero score is the absence of evidence, not weak evidence, so no
    // threshold may admit it.
    expect(predictFiles(criteria, candidates, { confidenceFloor: 0, runnerUpMargin: 0 })).toEqual([]);
    // A negative value reaches the same place through the same config key.
    expect(predictFiles(criteria, candidates, { confidenceFloor: -1, runnerUpMargin: -1 })).toEqual([]);
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
