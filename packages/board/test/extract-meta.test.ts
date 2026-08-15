import { describe, expect, it } from "vitest";
import { extractPhases } from "../src/extract-meta.js";
// Every source lives in `fixtures/extractor-sources.ts` so the parity suite can drive the exact
// same shapes through the pack's mirror — see that file's doc comment.
import { EXTRACTOR_SOURCES as S } from "./fixtures/extractor-sources.js";

describe("extractPhases", () => {
  it("takes phases from phase() calls, in source order, deduped", () => {
    expect(extractPhases(S.phaseCallsDeduped).phases.map((p) => p.title)).toEqual(["Build", "Review"]);
  });

  // CHANGED from "ordered by first appearance": phase order now comes from the sequence of
  // phase() CALLS, never from an option's lexical position. This fixture is the minimal case of
  // the bug that motivated the fix — a wrap-up helper's `{ phase: 'X' }` option, written above the
  // first real phase() call, used to drag its phase to the front of the diagram. Verify's agent
  // call sits first in the source, but Gate is the only phase() call, so Gate now leads and Verify
  // — never named in a phase() call — is appended after it.
  it("orders phase() calls first; a title that appears only in a { phase } option is appended after", () => {
    expect(extractPhases(S.optionOnlyTitleAfterDeclared).phases.map((p) => p.title)).toEqual(["Gate", "Verify"]);
  });

  it("orders declared phases by their phase() call sequence even when an option-only title's call sits earlier in the file", () => {
    expect(extractPhases(S.optionOnlyTitleFromHoistedHelper).phases.map((p) => p.title)).toEqual([
      "Build",
      "Verify",
      "Complete",
    ]);
  });

  it("appends every option-only title after all declared phases, in its own first-appearance order", () => {
    expect(extractPhases(S.twoOptionOnlyTitles).phases.map((p) => p.title)).toEqual([
      "Build",
      "Verify",
      "Handoff",
      "Complete",
    ]);
  });

  it("reports a non-literal phase option with no ambient phase() call as unclassified, not a fabricated phase", () => {
    const { phases, unclassified } = extractPhases(S.nonLiteralPhaseUnclassified);
    expect(unclassified).toHaveLength(1);
    expect(unclassified[0]?.callee).toBe("agent");
    // The reason distinguishes "cannot be placed in a band" from "drawn but captioned with an
    // ellipsis" — two different author mistakes that used to share one message in validate.
    expect(unclassified[0]?.reason).toBe("phase");
    const steps = phases.flatMap((p) => p.steps);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.label).toBe("resolvable");
  });

  it("still resolves a non-literal phase option through an ambient phase() call rather than reporting it unclassified", () => {
    const { phases, unclassified } = extractPhases(S.nonLiteralPhaseWithAmbient);
    expect(unclassified).toHaveLength(0);
    expect(phases[0]?.steps[0]?.label).toBe("still fine");
  });

  it("falls back to a single Run phase when the body declares none", () => {
    expect(extractPhases(S.noPhasesDeclared).phases.map((p) => p.title)).toEqual(["Run"]);
  });

  it("parses a body with top-level return and await", () => {
    expect(() => extractPhases(S.topLevelReturnAndAwait)).not.toThrow();
  });

  it("makes one step per call site, with agent taken from agentType", () => {
    const { phases } = extractPhases(S.literalAgentType);
    expect(phases[0]?.steps).toEqual([{ id: "build-1", label: "build T1.1", agent: "ios-dev" }]);
  });

  it("omits agent when the call names no agentType, and does not record it as computed", () => {
    const { phases, computedAgentType } = extractPhases(S.noAgentType);
    expect(phases[0]?.steps[0]).toEqual({ id: "build-1", label: "build" });
    expect(computedAgentType).toEqual([]);
  });

  // `agentType: task.role` — present, but not a string literal. Dispatch is real at runtime; the
  // extractor just cannot name it. This is NOT the same as the call above naming no agentType at
  // all: the step still comes out with no `agent` field (nothing to draw), but `computedAgentType`
  // records the call site so `validate` can tell "computed" apart from "genuinely absent" and not
  // report a false defect. See the 2026-08-15 workflow-generated-meta plan, task 14, fix round 1.
  it("omits agent when agentType is computed, and records the call site in computedAgentType", () => {
    const { phases, computedAgentType } = extractPhases(S.computedAgentType);
    expect(phases[0]?.steps[0]).toEqual({ id: "build-1", label: "build" });
    expect(computedAgentType).toEqual([{ line: 3, stepId: "build-1" }]);
  });

  it("does not record computedAgentType when agentType is a literal", () => {
    expect(extractPhases(S.literalAgentTypeShortLabel).computedAgentType).toEqual([]);
  });

  it("renders a concatenated or interpolated label with an ellipsis", () => {
    const steps = extractPhases(S.computedLabels).phases[0]?.steps ?? [];
    expect(steps[0]?.label).toBe("build …");
    expect(steps[1]?.label).toBe("review …:security");
  });

  it("marks a workflow() call as a workflow node, labelled by its script path", () => {
    expect(extractPhases(S.workflowNode).phases[0]?.steps[0]).toEqual({
      id: "ship-1",
      label: "testing",
      kind: "workflow",
    });
  });

  it("honours an explicit kind on an agent call", () => {
    expect(extractPhases(S.commandKind).phases[0]?.steps[0]).toEqual({
      id: "build-1",
      label: "set status active",
      agent: "project-manager",
      kind: "command",
    });
  });

  it("chains sequential calls within a phase", () => {
    const steps = extractPhases(S.sequentialChain).phases[0]?.steps ?? [];
    expect(steps[0]?.dependsOn).toBeUndefined();
    expect(steps[1]?.dependsOn).toEqual(["build-1"]);
  });

  it("gives parallel() members one group, all hanging off what preceded the block", () => {
    const steps = extractPhases(S.parallelThunkList).phases[0]?.steps ?? [];
    expect(steps[1]?.parallel).toBe("g1");
    expect(steps[2]?.parallel).toBe("g1");
    expect(steps[1]?.dependsOn).toEqual(["review-1"]);
    expect(steps[2]?.dependsOn).toEqual(["review-1"]);
    expect(steps[3]?.dependsOn).toEqual(["review-2", "review-3"]);
    // A literal array of thunks is a known, enumerable set — each member is its own node, and
    // nothing about it repeats. This is the behaviour the computed-members rule below must NOT
    // change.
    expect(steps.some((s) => s.repeat)).toBe(false);
  });

  // `parallel(tasks.map(…))` is the idiomatic fan-out and has ONE lexical call site inside it. It
  // is not in a loop, so it used to draw as a single unbadged node — the diagram claiming one
  // reviewer where N run concurrently. Understating concurrency is the dangerous direction of error
  // here: the diagram exists to make concurrency visible, and file-writing steps share one working
  // tree.
  it("badges a parallel() whose members are computed by .map — one call site, N concurrent runs", () => {
    const steps = extractPhases(S.parallelMappedFanOut).phases[0]?.steps ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({
      id: "review-1",
      label: "review …",
      agent: "tech-lead",
      repeat: true,
      parallel: "g1",
    });
  });

  it("badges a spread into a literal array too — the brackets are there, the members are not", () => {
    const steps = extractPhases(S.parallelSpreadFanOut).phases[0]?.steps ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]?.repeat).toBe(true);
  });

  it("marks a call inside a loop as repeating, and does not multiply it", () => {
    const steps = extractPhases(S.loopRepeat).phases[0]?.steps ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]?.repeat).toBe(true);
  });

  it("chains pipeline() stages rather than fanning them out", () => {
    const steps = extractPhases(S.pipelineStages).phases[0]?.steps ?? [];
    expect(steps[0]?.parallel).toBeUndefined();
    expect(steps[0]?.repeat).toBe(true);
    expect(steps[1]?.dependsOn).toEqual(["verify-1"]);
    expect(steps[1]?.repeat).toBe(true);
  });

  // Two phases whose titles differ only in case are two real bands, so they are NOT folded into
  // one — but `<phase-slug>-<n>` would mint two `build-1` ids, and the diagram keys its nodes by
  // id: the second would overwrite the first in `byId`, collapsing every implicit edge between the
  // bands into a self-loop.
  it("keeps step ids unique when two phase titles slugify the same", () => {
    const { phases } = extractPhases(S.caseCollidingPhases);
    expect(phases.map((p) => p.title)).toEqual(["Build", "build"]);
    const ids = phases.flatMap((p) => p.steps.map((s) => s.id));
    expect(ids).toEqual(["build-1", "build-2-1"]);
    expect(new Set(ids).size).toBe(ids.length);
    // …and the second band's step still chains off the first band's, by a live id.
    expect(phases[1]?.steps[0]?.dependsOn).toBeUndefined();
  });

  // `serializeMeta` writes each step with `JSON.stringify(step)`, so the order fields are
  // ASSIGNED onto the step object becomes the order they land in the file — and `coerceStep` in
  // workflow-meta.ts reads a step back assuming exactly that order: id, label, agent, kind,
  // repeat, parallel, backend, dependsOn. `toEqual` above ignores key order, so nothing catches a
  // future edit that reorders the assignments; this test exists purely to pin that order.
  it("writes a step's keys in the canonical order id, label, agent, kind, repeat, parallel, backend, dependsOn", () => {
    const steps = extractPhases(S.everyStepField).phases[0]?.steps ?? [];
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
    const steps = extractPhases(S.hoistedParallelHelper).phases[0]?.steps ?? [];
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
