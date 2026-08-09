import { describe, expect, it } from "vitest";
import { layerRanks } from "../src/layers.js";

describe("layerRanks", () => {
  it("ranks entry points at 0 and their dependencies below", () => {
    const ranks = layerRanks(["app", "lib", "core"], [
      { from: "app", to: "lib", weight: 1 },
      { from: "lib", to: "core", weight: 1 },
    ]);
    expect(ranks?.get("app")).toBe(0);
    expect(ranks?.get("lib")).toBe(1);
    expect(ranks?.get("core")).toBe(2);
  });

  it("contracts a cycle to a single rank rather than looping forever", () => {
    const ranks = layerRanks(["a", "b"], [
      { from: "a", to: "b", weight: 1 },
      { from: "b", to: "a", weight: 1 },
    ]);
    expect(ranks).not.toBeNull();
    expect(ranks?.get("a")).toBe(ranks?.get("b"));
  });

  it("ranks a module downstream of a cycle strictly deeper than the cycle", () => {
    // a -> b, b <-> c (cycle), c -> d. `d` is not in the cycle and must not
    // be flattened into it — a naive Kahn sweep stalls at the cycle and dumps
    // everything downstream into one rank.
    const ranks = layerRanks(["a", "b", "c", "d"], [
      { from: "a", to: "b", weight: 1 },
      { from: "b", to: "c", weight: 1 },
      { from: "c", to: "b", weight: 1 },
      { from: "c", to: "d", weight: 1 },
    ]);
    expect(ranks?.get("a")).toBe(0);
    expect(ranks?.get("b")).toBe(ranks?.get("c"));
    expect(ranks?.get("d")).toBeGreaterThan(ranks?.get("c") ?? 0);
  });

  it("returns null with no import edges — ranks must not be guessed", () => {
    expect(layerRanks(["a", "b"], [])).toBeNull();
  });
});
