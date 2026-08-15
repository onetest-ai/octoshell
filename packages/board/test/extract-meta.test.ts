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

  it("makes one step per call site, with agent taken from agentType", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'build T1.1', agentType: 'ios-dev' })
`;
    const { phases } = extractPhases(src);
    expect(phases[0]?.steps).toEqual([{ id: "build-1", label: "build T1.1", agent: "ios-dev" }]);
  });

  it("omits agent when the call names no agentType", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'build' })
`;
    expect(extractPhases(src).phases[0]?.steps[0]).toEqual({ id: "build-1", label: "build" });
  });

  it("renders a concatenated or interpolated label with an ellipsis", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'build ' + t.id, agentType: 'ios-dev' })
await agent(p, { phase: 'Build', label: \`review \${t.id}:security\`, agentType: 'tech-lead' })
`;
    const steps = extractPhases(src).phases[0]?.steps ?? [];
    expect(steps[0]?.label).toBe("build …");
    expect(steps[1]?.label).toBe("review …:security");
  });

  it("marks a workflow() call as a workflow node, labelled by its script path", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Ship')
await workflow({ scriptPath: '.octobots/campaigns/c/workflows/testing/workflow.js' })
`;
    expect(extractPhases(src).phases[0]?.steps[0]).toEqual({
      id: "ship-1",
      label: "testing",
      kind: "workflow",
    });
  });

  it("honours an explicit kind on an agent call", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'set status active', agentType: 'project-manager', kind: 'command' })
`;
    expect(extractPhases(src).phases[0]?.steps[0]).toEqual({
      id: "build-1",
      label: "set status active",
      agent: "project-manager",
      kind: "command",
    });
  });
});
