/**
 * Every workflow-body shape the extractor unit tests exercise, in one place.
 *
 * Two suites read this module: `extract-meta.test.ts` asserts what each shape yields, and
 * `extract-meta-parity.test.ts` runs every one of them through BOTH extractors (the TS one here and
 * the pack's `extract-meta.mjs`) and asserts identical output. The nine-workflow corpus is real
 * code, but narrow — it contains no `pipeline()`, no `workflow()` node, no `backend`, no
 * `kind: 'command'` and no binary-expression label — so before this, several mirrored branches had
 * a unit test on one side and no guard on the other.
 *
 * Adding a shape here is therefore how you get it covered on both sides at once.
 */
export const EXTRACTOR_SOURCES = {
  /** phase() calls, in source order, deduped. */
  phaseCallsDeduped: `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
phase('Review')
phase('Build')
`,

  /** An option-only title whose call sits before the only phase() call. */
  optionOnlyTitleAfterDeclared: `export const meta = { name: "w", description: "", phases: [] }
await agent('x', { phase: 'Verify', label: 'v', agentType: 'qa' })
phase('Gate')
`,

  /** A wrap-up helper declared above the phase() calls it is invoked after. */
  optionOnlyTitleFromHoistedHelper: `export const meta = { name: "w", description: "", phases: [] }
const finish = () => agent('x', { phase: 'Complete', label: 'wrap up', agentType: 'run-reporter' })
phase('Build')
phase('Verify')
`,

  /** Two option-only titles, appended in their own first-appearance order. */
  twoOptionOnlyTitles: `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
phase('Verify')
await agent('x', { phase: 'Handoff', label: 'h', agentType: 'run-reporter' })
await agent('y', { phase: 'Complete', label: 'c', agentType: 'run-reporter' })
`,

  /** A `{ phase: someVar }` with no ambient phase() call to fall back on. */
  nonLiteralPhaseUnclassified: `export const meta = { name: "w", description: "", phases: [] }
const ph = 'Build'
await agent('x', { phase: ph, label: 'unresolvable', agentType: 'project-manager' })
phase('Build')
await agent('y', { phase: 'Build', label: 'resolvable', agentType: 'qa' })
`,

  /** The same, but rescued by an ambient phase() call. */
  nonLiteralPhaseWithAmbient: `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
const ph = 'Build'
await agent('x', { phase: ph, label: 'still fine', agentType: 'project-manager' })
`,

  /** No phase() call anywhere. */
  noPhasesDeclared: `export const meta = { name: "w", description: "", phases: [] }
await agent('x', { label: 'v', agentType: 'qa' })
`,

  /** Top-level `return` and `await` — legal in the Workflow dialect. */
  topLevelReturnAndAwait: `export const meta = { name: "w", description: "", phases: [] }
phase('Run')
const r = await agent('x', { label: 'v', agentType: 'qa' })
if (!r) return { blocked: 'agent-died' }
return r
`,

  /** One step per call site, agent taken from agentType. */
  literalAgentType: `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'build T1.1', agentType: 'ios-dev' })
`,

  /** No agentType at all — a real defect, and not the computed case. */
  noAgentType: `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'build' })
`,

  /** `agentType: task.role` — dispatches for real, unreadable to the extractor. */
  computedAgentType: `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'build', agentType: task.role })
`,

  /** A literal agentType, for the "not recorded as computed" case. */
  literalAgentTypeShortLabel: `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'build', agentType: 'ios-dev' })
`,

  /** Concatenated and interpolated labels. */
  computedLabels: `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'build ' + t.id, agentType: 'ios-dev' })
await agent(p, { phase: 'Build', label: \`review \${t.id}:security\`, agentType: 'tech-lead' })
`,

  /** A workflow() node, labelled by its script path. */
  workflowNode: `export const meta = { name: "w", description: "", phases: [] }
phase('Ship')
await workflow({ scriptPath: '.octobots/campaigns/c/workflows/testing/workflow.js' })
`,

  /** An explicit `kind: 'command'`. */
  commandKind: `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'set status active', agentType: 'project-manager', kind: 'command' })
`,

  /** Two sequential calls in one phase. */
  sequentialChain: `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'a', agentType: 'x' })
await agent(p, { phase: 'Build', label: 'b', agentType: 'x' })
`,

  /** A literal array of thunks — a known, enumerable fan-out. */
  parallelThunkList: `export const meta = { name: "w", description: "", phases: [] }
phase('Review')
await agent(p, { phase: 'Review', label: 'build', agentType: 'dev' })
const r = await parallel([
  () => agent(p, { phase: 'Review', label: 'correctness', agentType: 'tech-lead' }),
  () => agent(p, { phase: 'Review', label: 'security', agentType: 'tech-lead' }),
])
await agent(p, { phase: 'Review', label: 'verify', agentType: 'qa' })
`,

  /**
   * The idiomatic fan-out: one lexical call site, N concurrent runs at run time. Not inside a loop,
   * so nothing but the computed-members rule would badge it.
   */
  parallelMappedFanOut: `export const meta = { name: "w", description: "", phases: [] }
phase('Review')
await parallel(tasks.map((t) => () => agent(p, { phase: 'Review', label: 'review ' + t.id, agentType: 'tech-lead' })))
`,

  /** A literal array whose members arrive by spread — computed too, despite the brackets. */
  parallelSpreadFanOut: `export const meta = { name: "w", description: "", phases: [] }
phase('Review')
await parallel([...tasks.map((t) => () => agent(p, { phase: 'Review', label: 'review ' + t.id, agentType: 'tech-lead' }))])
`,

  /** A call inside a loop: one node, badged. */
  loopRepeat: `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
for (const t of tasks) {
  await agent(p, { phase: 'Build', label: 'build ' + t.id, agentType: 'ios-dev' })
}
`,

  /** pipeline() stages chain and repeat rather than fanning out. */
  pipelineStages: `export const meta = { name: "w", description: "", phases: [] }
phase('Verify')
await pipeline(items,
  (i) => agent(p, { phase: 'Verify', label: 'review', agentType: 'tech-lead' }),
  (r) => agent(p, { phase: 'Verify', label: 'confirm', agentType: 'qa' }),
)
`,

  /** Every optional step field at once, for the canonical key-order pin. */
  everyStepField: `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'first', agentType: 'x' })
for (const t of tasks) {
  await parallel([
    () => agent(p, { phase: 'Build', label: 'a', agentType: 'y', kind: 'command', backend: 'codex' }),
  ])
}
`,

  /** Two phases whose titles slugify identically — two real bands, one slug. */
  caseCollidingPhases: `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
await agent(p, { phase: 'Build', label: 'upper', agentType: 'x' })
phase('build')
await agent(p, { phase: 'build', label: 'lower', agentType: 'y' })
`,

  /** A parallel() helper hoisted above the loop that invokes it — the pinned known limitation. */
  hoistedParallelHelper: `export const meta = { name: "w", description: "", phases: [] }
phase('Build')
const round = () => parallel([
  () => agent(p, { phase: 'Build', label: 'review', agentType: 'tech-lead' }),
])
for (const t of tasks) {
  await agent(p, { phase: 'Build', label: 'build ' + t.id, agentType: 'ios-dev' })
  await round()
}
`,
};
