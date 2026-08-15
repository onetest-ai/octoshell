import { describe, expect, it } from "vitest";
import { extractPhases } from "../src/extract-meta.js";

describe("extractPhases", () => {
  it("takes phases from phase() calls, in source order, deduped", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
phase('Review')
phase('Build')
`;
    expect(extractPhases(src).phases.map((p) => p.title)).toEqual(["Build", "Review"]);
  });

  it("takes phases from a { phase } option too, ordered by first appearance", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
await agent('x', { phase: 'Verify', label: 'v', agentType: 'qa' })
phase('Gate')
`;
    expect(extractPhases(src).phases.map((p) => p.title)).toEqual(["Verify", "Gate"]);
  });

  it("falls back to a single Run phase when the body declares none", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
await agent('x', { label: 'v', agentType: 'qa' })
`;
    expect(extractPhases(src).phases.map((p) => p.title)).toEqual(["Run"]);
  });

  it("parses a body with top-level return and await", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Run')
const r = await agent('x', { label: 'v', agentType: 'qa' })
if (!r) return { blocked: 'agent-died' }
return r
`;
    expect(() => extractPhases(src)).not.toThrow();
  });
});
