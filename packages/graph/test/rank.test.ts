import { describe, expect, it } from "vitest";
import { rankScore } from "../src/rank.js";

describe("rankScore", () => {
  it("discounts a pair sitting exactly at the minSupport floor to half its nPMI", () => {
    expect(rankScore(0.9, 2, 2)).toBeCloseTo(0.45, 10);
  });

  it("fades the discount toward nothing as support grows past the floor", () => {
    const atFloor = rankScore(0.8, 2, 2);
    const doubleFloor = rankScore(0.8, 4, 2);
    const wellPast = rankScore(0.8, 40, 2);
    expect(doubleFloor).toBeGreaterThan(atFloor);
    expect(wellPast).toBeGreaterThan(doubleFloor);
    expect(wellPast).toBeLessThan(0.8);
    expect(wellPast).toBeCloseTo(0.8, 1); // support >> minSupport: nearly undiscounted
  });

  it("preserves nPMI order between two pairs with equal support", () => {
    const weaker = rankScore(0.6, 5, 2);
    const stronger = rankScore(0.9, 5, 2);
    expect(stronger).toBeGreaterThan(weaker);
  });

  /**
   * The exact octoweb-shaped case (see `.octobots/campaigns/
   * octograph-code-architecture-graph/bugs/
   * drift-ranks-a-pair-seen-twice-above-a-pair-seen-ni/`): a pair seen
   * exactly `minSupport` times, at nPMI 1.000 — the maximum possible — must
   * NOT outrank a pair seen 9 times at a moderately lower nPMI (0.873). This
   * is the regression `rankScore` exists to fix; `edgeWeight` alone (i.e.
   * comparing nPMI directly) gets this backwards.
   */
  it("does not let a two-observation coincidence at nPMI 1.0 outrank nine repeated observations at nPMI 0.873", () => {
    const twiceSeenMax = rankScore(1.0, 2, 2);
    const nineTimesSeen = rankScore(0.873, 9, 2);
    expect(nineTimesSeen).toBeGreaterThan(twiceSeenMax);
  });

  it("never divides by zero: support and minSupport are always positive", () => {
    expect(Number.isFinite(rankScore(0.5, 2, 2))).toBe(true);
    expect(rankScore(0, 2, 2)).toBe(0);
  });
});
