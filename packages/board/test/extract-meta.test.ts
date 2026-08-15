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

  // CHANGED from "ordered by first appearance": phase order now comes from the sequence of
  // phase() CALLS, never from an option's lexical position. This fixture is the minimal case of
  // the bug that motivated the fix — a wrap-up helper's `{ phase: 'X' }` option, written above the
  // first real phase() call, used to drag its phase to the front of the diagram. Verify's agent
  // call sits first in the source, but Gate is the only phase() call, so Gate now leads and Verify
  // — never named in a phase() call — is appended after it.
  it("orders phase() calls first; a title that appears only in a { phase } option is appended after", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
await agent('x', { phase: 'Verify', label: 'v', agentType: 'qa' })
phase('Gate')
`;
    expect(extractPhases(src).phases.map((p) => p.title)).toEqual(["Gate", "Verify"]);
  });

  it("orders declared phases by their phase() call sequence even when an option-only title's call sits earlier in the file", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
const finish = () => agent('x', { phase: 'Complete', label: 'wrap up', agentType: 'run-reporter' })
phase('Build')
phase('Verify')
`;
    expect(extractPhases(src).phases.map((p) => p.title)).toEqual(["Build", "Verify", "Complete"]);
  });

  it("appends every option-only title after all declared phases, in its own first-appearance order", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
phase('Verify')
await agent('x', { phase: 'Handoff', label: 'h', agentType: 'run-reporter' })
await agent('y', { phase: 'Complete', label: 'c', agentType: 'run-reporter' })
`;
    expect(extractPhases(src).phases.map((p) => p.title)).toEqual(["Build", "Verify", "Handoff", "Complete"]);
  });

  it("reports a non-literal phase option with no ambient phase() call as unclassified, not a fabricated phase", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
const ph = 'Build'
await agent('x', { phase: ph, label: 'unresolvable', agentType: 'project-manager' })
phase('Build')
await agent('y', { phase: 'Build', label: 'resolvable', agentType: 'qa' })
`;
    const { phases, unclassified } = extractPhases(src);
    expect(unclassified).toHaveLength(1);
    expect(unclassified[0]?.callee).toBe("agent");
    const steps = phases.flatMap((p) => p.steps);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.label).toBe("resolvable");
  });

  it("still resolves a non-literal phase option through an ambient phase() call rather than reporting it unclassified", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
const ph = 'Build'
await agent('x', { phase: ph, label: 'still fine', agentType: 'project-manager' })
`;
    const { phases, unclassified } = extractPhases(src);
    expect(unclassified).toHaveLength(0);
    expect(phases[0]?.steps[0]?.label).toBe("still fine");
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

  it("omits agent when the call names no agentType, and does not record it as computed", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'build' })
`;
    const { phases, computedAgentType } = extractPhases(src);
    expect(phases[0]?.steps[0]).toEqual({ id: "build-1", label: "build" });
    expect(computedAgentType).toEqual([]);
  });

  // `agentType: task.role` — present, but not a string literal. Dispatch is real at runtime; the
  // extractor just cannot name it. This is NOT the same as the call above naming no agentType at
  // all: the step still comes out with no `agent` field (nothing to draw), but `computedAgentType`
  // records the call site so `validate` can tell "computed" apart from "genuinely absent" and not
  // report a false defect. See the 2026-08-15 workflow-generated-meta plan, task 14, fix round 1.
  it("omits agent when agentType is computed, and records the call site in computedAgentType", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'build', agentType: task.role })
`;
    const { phases, computedAgentType } = extractPhases(src);
    expect(phases[0]?.steps[0]).toEqual({ id: "build-1", label: "build" });
    expect(computedAgentType).toEqual([{ line: 3, stepId: "build-1" }]);
  });

  it("does not record computedAgentType when agentType is a literal", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'build', agentType: 'ios-dev' })
`;
    expect(extractPhases(src).computedAgentType).toEqual([]);
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

  it("chains sequential calls within a phase", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'a', agentType: 'x' })
await agent(p, { phase: 'Build', label: 'b', agentType: 'x' })
`;
    const steps = extractPhases(src).phases[0]?.steps ?? [];
    expect(steps[0]?.dependsOn).toBeUndefined();
    expect(steps[1]?.dependsOn).toEqual(["build-1"]);
  });

  it("gives parallel() members one group, all hanging off what preceded the block", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Review')
await agent(p, { phase: 'Review', label: 'build', agentType: 'dev' })
const r = await parallel([
  () => agent(p, { phase: 'Review', label: 'correctness', agentType: 'tech-lead' }),
  () => agent(p, { phase: 'Review', label: 'security', agentType: 'tech-lead' }),
])
await agent(p, { phase: 'Review', label: 'verify', agentType: 'qa' })
`;
    const steps = extractPhases(src).phases[0]?.steps ?? [];
    expect(steps[1]?.parallel).toBe("g1");
    expect(steps[2]?.parallel).toBe("g1");
    expect(steps[1]?.dependsOn).toEqual(["review-1"]);
    expect(steps[2]?.dependsOn).toEqual(["review-1"]);
    expect(steps[3]?.dependsOn).toEqual(["review-2", "review-3"]);
  });

  it("marks a call inside a loop as repeating, and does not multiply it", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
for (const t of tasks) {
  await agent(p, { phase: 'Build', label: 'build ' + t.id, agentType: 'ios-dev' })
}
`;
    const steps = extractPhases(src).phases[0]?.steps ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]?.repeat).toBe(true);
  });

  it("chains pipeline() stages rather than fanning them out", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Verify')
await pipeline(items,
  (i) => agent(p, { phase: 'Verify', label: 'review', agentType: 'tech-lead' }),
  (r) => agent(p, { phase: 'Verify', label: 'confirm', agentType: 'qa' }),
)
`;
    const steps = extractPhases(src).phases[0]?.steps ?? [];
    expect(steps[0]?.parallel).toBeUndefined();
    expect(steps[0]?.repeat).toBe(true);
    expect(steps[1]?.dependsOn).toEqual(["verify-1"]);
    expect(steps[1]?.repeat).toBe(true);
  });

  // `serializeMeta` writes each step with `JSON.stringify(step)`, so the order fields are
  // ASSIGNED onto the step object becomes the order they land in the file — and `coerceStep` in
  // workflow-meta.ts reads a step back assuming exactly that order: id, label, agent, kind,
  // repeat, parallel, backend, dependsOn. `toEqual` above ignores key order, so nothing catches a
  // future edit that reorders the assignments; this test exists purely to pin that order.
  it("writes a step's keys in the canonical order id, label, agent, kind, repeat, parallel, backend, dependsOn", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'first', agentType: 'x' })
for (const t of tasks) {
  await parallel([
    () => agent(p, { phase: 'Build', label: 'a', agentType: 'y', kind: 'command', backend: 'codex' }),
  ])
}
`;
    const steps = extractPhases(src).phases[0]?.steps ?? [];
    const step = steps[1];
    expect(step).toEqual({
      id: "build-2",
      label: "a",
      agent: "y",
      kind: "command",
      repeat: true,
      parallel: "g1",
      backend: "codex",
      dependsOn: ["build-1"],
    });
    expect(Object.keys(step ?? {})).toEqual([
      "id",
      "label",
      "agent",
      "kind",
      "repeat",
      "parallel",
      "backend",
      "dependsOn",
    ]);
  });

  // KNOWN LIMITATION, pinned rather than endorsed: the extractor attributes a call to its lexical
  // position, not to where it actually runs. A `parallel([...])` helper defined ABOVE a loop and
  // only invoked from inside it (`round()` below — an untracked call name) is attributed to its
  // definition site, ahead of the loop. So "review" — which in reality runs once per iteration,
  // after "build" — is not marked `repeat`, is numbered ahead of "build", and "build" ends up with
  // a `dependsOn` on it: backwards from the real per-iteration order (build, then round()). A
  // future fix for this must turn this test red before it can turn it green differently.
  it("[known limitation] attributes a parallel() helper hoisted above a loop to its definition site, backwards from runtime order", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
const round = () => parallel([
  () => agent(p, { phase: 'Build', label: 'review', agentType: 'tech-lead' }),
])
for (const t of tasks) {
  await agent(p, { phase: 'Build', label: 'build ' + t.id, agentType: 'ios-dev' })
  await round()
}
`;
    const steps = extractPhases(src).phases[0]?.steps ?? [];
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ id: "build-1", label: "review", agent: "tech-lead", parallel: "g1" });
    expect(steps[1]).toEqual({
      id: "build-2",
      label: "build …",
      agent: "ios-dev",
      repeat: true,
      dependsOn: ["build-1"],
    });
  });
});
