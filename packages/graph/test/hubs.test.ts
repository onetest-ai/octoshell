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

  it("still flags a hub whose edges are half anti-correlated", () => {
    // A high-churn file scores negative nPMI against the other high-churn
    // files it seldom moves with. That is evidence of no coupling, not
    // evidence against being a hub — it must not cancel the hub's real edges.
    const edges: Edge[] = [];
    for (let i = 1; i <= 10; i++) edges.push(edge(0, i, 0.9));
    for (let i = 11; i <= 20; i++) edges.push(edge(0, i, -0.9));
    expect(detectHubs(edges, 21, { zThreshold: 3 }).has(0)).toBe(true);
  });

  it("ranks by weighted degree, not by how many neighbours a node has", () => {
    // Nodes 0 and 21 have identical degree (20). Only node 0's edges carry
    // real weight, so only node 0 is a hub — a plain edge count flags both.
    const edges: Edge[] = [];
    for (let i = 1; i <= 20; i++) edges.push(edge(0, i, 1));
    for (let i = 22; i <= 41; i++) edges.push(edge(21, i, 0.05));
    expect([...detectHubs(edges, 42, { zThreshold: 3 })]).toEqual([0]);
  });

  it("returns hub ids in ascending order", () => {
    // The set feeds a committed artifact; its iteration order is part of the
    // contract, so it must not follow edge order.
    const edges: Edge[] = [];
    for (let i = 12; i <= 21; i++) edges.push(edge(1, i, 1));
    for (let i = 2; i <= 11; i++) edges.push(edge(0, i, 1));
    expect([...detectHubs(edges, 60, { zThreshold: 3 })]).toEqual([0, 1]);
  });
});
