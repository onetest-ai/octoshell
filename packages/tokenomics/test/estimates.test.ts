import { describe, it, expect } from "vitest";
import { parseEstimateBlock } from "../src/estimates.js";

describe("parseEstimateBlock", () => {
  it("reads the authored fields", () => {
    const e = parseEstimateBlock(`# M1 - Thing

## Tokenomics
effort_days: 3
size_tshirt: M
complexity_score: 18
maturity: pilot
self_size: L
estimated_retrospectively: true
branches: feat/a, feat/b
`);
    expect(e).toMatchObject({
      effortDays: 3,
      sizeTshirt: "M",
      complexityScore: 18,
      maturity: "pilot",
      selfSize: "L",
      estimatedRetrospectively: true,
      branches: ["feat/a", "feat/b"],
    });
  });

  // Regression: with the `/m` flag needed for `^##`, a bare `$` terminator makes
  // the lazy body stop at the FIRST newline, silently truncating the block to
  // one line — so every field after the first is lost.
  it("reads the whole block, not just its first line", () => {
    const e = parseEstimateBlock("## Tokenomics\neffort_days: 5\nsize_tshirt: L\n");
    expect(e.effortDays).toBe(5);
    expect(e.sizeTshirt).toBe("L");
  });

  it("stops at the next section, not at an inline HTML comment", () => {
    const e = parseEstimateBlock(`## Tokenomics
effort_days: 2
<!-- a note the planner left inline -->
size_tshirt: S

## Tasks
- [status:done] T1.1 - Something
`);
    expect(e.effortDays).toBe(2);
    expect(e.sizeTshirt).toBe("S"); // survived the comment
  });

  it("returns an empty estimate when there is no block — never a zero", () => {
    const e = parseEstimateBlock("# M1 - Thing\n\n## Description\nnothing here\n");
    expect(e.effortDays).toBeNull();
    expect(e.sizeTshirt).toBeNull();
  });

  it("ignores a non-numeric effort rather than coercing it", () => {
    expect(parseEstimateBlock("## Tokenomics\neffort_days: soon\n").effortDays).toBeNull();
  });
});
