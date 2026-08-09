import { describe, expect, it } from "vitest";
import { detectHubs } from "../src/hubs.js";
import type { Edge } from "../src/weights.js";

const edge = (a: number, b: number, npmi = 0.5): Edge => ({
  a, b, support: 3, npmi, confidence: 0.5,
});

describe("detectHubs", () => {
  it("flags a node connected to far more of the graph than the rest", () => {
    // node 0 touches 0..19; every other node touches only node 0 plus a neighbour.
    const edges: Edge[] = [];
    for (let i = 1; i <= 20; i++) edges.push(edge(0, i));
    for (let i = 1; i < 20; i += 2) edges.push(edge(i, i + 1));
    expect(detectHubs(edges, 21, { zThreshold: 3 }).has(0)).toBe(true);
  });

  it("flags nothing in a uniform graph", () => {
    const edges = [edge(0, 1), edge(1, 2), edge(2, 3), edge(3, 0)];
    expect(detectHubs(edges, 4, { zThreshold: 3 }).size).toBe(0);
  });

  it("returns an empty set for fewer than three nodes", () => {
    expect(detectHubs([edge(0, 1)], 2).size).toBe(0);
  });
});
