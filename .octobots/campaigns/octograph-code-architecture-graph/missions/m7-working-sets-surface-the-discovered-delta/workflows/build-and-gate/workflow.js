export const meta = {
  name: "build-and-gate",
  description: "Drive M7's four tasks to a gated, verified done: sequential build+review+verify per task, then one mission gate",
  phases: [
    { title: "Build", steps: [
      {"id":"build-1","label":"… build","repeat":true},
    ] },
    { title: "Review", steps: [
      {"id":"review-1","label":"… review","agent":"tech-lead","repeat":true},
    ] },
    { title: "Verify", steps: [
      {"id":"verify-1","label":"… verify+land","agent":"qa-engineer","repeat":true},
    ] },
    { title: "Gate", steps: [] },
  ],
}

// ---------------------------------------------------------------------------
// Body. `meta` is the picture; this is the program. The `return { blocked }`
// guards ARE the design — a run that only walks Build -> Review -> Verify
// assumes each stage passes first time, and that optimism is what makes a red
// run read as done.
// ---------------------------------------------------------------------------

const REPO = '/Users/arozumenko/Development/octoshell'
const BASE = 'feat/octograph-code-architecture-graph'
const HEAD = 'feat/octograph-code-architecture-graph-m7'
const MDIR = '.octobots/campaigns/octograph-code-architecture-graph/missions/m7-working-sets-surface-the-discovered-delta'
const PLAN = 'docs/superpowers/plans/2026-08-10-octograph-working-sets.md'

const TASKS = [
  { id: 'T7.1', n: 1, slug: 't7-1-compute-boundary-crossing-working-sets-from-t', role: 'js-dev', planTask: 1, foundation: true, note:
    'FOUNDATION: T7.2, T7.3 and T7.4 all consume Analysis.workingSets.\n'
    + 'The noise-floor discriminant is `classifyPair(a,b) !== "candidate"`, spelled exactly as\n'
    + 'drift.ts:105 spells it. PairClass has no "signal" member — an earlier draft of the plan said\n'
    + '"signal" and would not have compiled.\n'
    + 'Do NOT claim that guard handles test-subject pairs: A8 strips test ids from the edge set\n'
    + 'before louvain() runs, so no test file can ever reach a community. Only the manifest/lockfile\n'
    + 'case actually arrives there.\n'
    + 'Name each set by its most central member via nameCluster over bridgedEdges — the edge set\n'
    + 'clustering actually saw, not `edges`. A set name is a FILE PATH, never a module name.' },

  { id: 'T7.2', n: 2, slug: 't7-2-one-spelling-of-the-thin-history-rule-and-sup', role: 'js-dev', planTask: 2, foundation: true, note:
    'FOUNDATION: criterion 3 of the mission rests on this.\n'
    + 'Suppress inside analyze(), NOT in the renderer — map.md, the artifact and M6\'s future bridge\n'
    + 'must all inherit one suppression rather than each carrying a copy.\n'
    + 'The equivalence "workingSets empty <=> doctor says degraded" is true TODAY only because\n'
    + 'doctor\'s only two required:true checks are `repository` (always ok on any branch that reaches\n'
    + 'the grade) and `history depth`. Test it THROUGH doctor(), not through minCommits, or the test\n'
    + 'proves nothing about the criterion it exists for.' },

  { id: 'T7.3', n: 3, slug: 't7-3-render-the-working-sets-section-in-map-md', role: 'js-dev', planTask: 3, foundation: false, note:
    'Slice by SET, never by line. visibleEdges is sliced by line only because one edge is exactly\n'
    + 'one line; a working set is a header plus N file lines, so slicing lines cuts a set mid-\n'
    + 'membership and renders a header claiming "10 files" above four of them. Filter\n'
    + 'analysis.workingSets by set count FIRST, then flat-map to lines.\n'
    + 'The dangling-reference filter is the same rule visibleEdges applies — a set naming a module\n'
    + 'the budget trimmed is a dangling reference in a committed artifact. M2 fixed that same defect\n'
    + 'three times because each fix was pinned at the layer the bug was found in rather than at the\n'
    + 'boundary the harm crosses.\n'
    + 'render.test.ts holds the only hand-built Analysis literal in the test tree; it needs\n'
    + 'workingSets: [] or the file will not typecheck.' },

  { id: 'T7.4', n: 4, slug: 't7-4-end-to-end-degraded-suppression-no-dangling-m', role: 'qa-engineer', planTask: 4, foundation: false, note:
    'Assert against the RENDERED map.md on disk, driven through runCli — never against an in-memory\n'
    + 'Analysis. That distinction is exactly what M2 got wrong three times.' },
]

const RULES = `
NON-NEGOTIABLE (violating any of these fails the task):
- Work in ${REPO}. ONE working tree, branches only. NEVER 'git worktree add'.
- SCOPED STAGING: 'git add <exact paths>'. NEVER 'git add -A' — .octobots/ is gitignored and the
  tree may hold another agent's edits.
- ESM + NodeNext: every relative import carries a .js extension. strict +
  noUncheckedIndexedAccess; never a non-null assertion (!) to silence them.
- Determinism: no Date.now(), no Math.random() in graph computation, and any iteration order that
  reaches output must be explicitly sorted. map.md is a COMMITTED artifact; churn destroys it.
- Read edge weights only through edgeWeight(); order only through compare(). NEVER localeCompare —
  it collates by the machine's locale, so a committed artifact reorders on a change of LANG.
- Reuse the single spelling of a rule: isTestPath and classifyPair (noise.ts), insideRepo
  (paths.ts), compare and edgeWeight (rollup/weights), historyIsThin (config.ts, from T7.2).
  conventions.test.ts guards this; a second spelling is a defect, not a style choice.
- Fixture repos MUST use mkdtempClean — never a bare mkdtempSync. The suite leaked 2,502 repos and
  1.2GB before that landed, and it only ever failed on CI.
- Anything a consumer needs is re-exported from src/index.ts or it does not exist outside the
  package. Two prior missions shipped whole subsystems that never reached that file.
- Trailer: Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
`

const BUILD = { type:'object', required:['tests_pass','summary'], properties:{
  branch:{type:'string'}, files_changed:{type:'array',items:{type:'string'}},
  tests_pass:{type:'boolean'}, pr_url:{type:'string'}, summary:{type:'string'},
  blockers:{type:'array',items:{type:'string'}} } }

const REVIEW = { type:'object', required:['fixed','stillOpen','final_state_green','summary'], properties:{
  fixed:{type:'array',items:{type:'object',required:['finding','regression_test'],properties:{
    finding:{type:'string'}, file:{type:'string'}, regression_test:{type:'string'} }}},
  stillOpen:{type:'array',items:{type:'object',required:['finding','why'],properties:{
    finding:{type:'string'}, why:{type:'string'} }}},
  nits:{type:'array',items:{type:'string'}},
  final_state_green:{type:'boolean'}, summary:{type:'string'} } }

const LAND = { type:'object', required:['passed','merged','summary'], properties:{
  passed:{type:'boolean'}, merged:{type:'boolean'}, pr_url:{type:'string'},
  criteria:{type:'array',items:{type:'object',required:['text','pass'],properties:{
    text:{type:'string'}, pass:{type:'boolean'}, evidence:{type:'string'} }}},
  failures:{type:'array',items:{type:'string'}}, summary:{type:'string'} } }

const results = []

for (const task of TASKS) {
  const board = `${MDIR}/tasks/${task.slug}/task.yaml`
  const branch = `${HEAD}-t${task.n}`

  phase('Build')
  const build = await agent(
    `Build task ${task.id} of Octobots mission M7 (working sets — surface the discovered delta) in ${REPO}.

WHY THIS MISSION EXISTS: after mission M2, the Louvain clustering stopped reaching any rendered
output at all. Module rows, members, edges and layer ranks are ALL determined by the declared
spine, so the "discovered" half of the design promise (spec D3: declared spine + discovered delta)
silently vanished. M7 puts it back as a READ-ONLY section in map.md. It changes nothing about
module identity or membership — those stay declared (spec A5c).

SPEC: ${PLAN} — the section "### Task ${task.planTask}:". Read the whole plan header first
(Global Constraints and the measured baseline table), then your task's section.
SCOPE AND OUT-OF-SCOPE: ${board} — read the description, it says what this task does NOT cover.
The acceptance criteria in that file are the contract you are judged against.

SPECIFIC TO THIS TASK:
${task.note}

Also read ${REPO}/CLAUDE.md, ${REPO}/AGENTS.md and ${REPO}/.agents/knowledge/ — the knowledge layer
is short and every note in it was paid for.

${RULES}

STEPS:
1. git checkout ${HEAD} && git pull --ff-only && git checkout -b ${branch}
2. TDD: write the failing test, RUN IT and confirm it fails for the right reason, implement, green.
3. All three green before you finish, and every pre-existing test must still pass:
     pnpm --filter @octoshell/graph test / typecheck / lint
4. Commit incrementally, scoped. Push. Open a PR into ${HEAD} with 'gh pr create --base ${HEAD}'.

Do NOT check off acceptance criteria, do NOT change task status, do NOT merge — QA owns all three.
If something is not green, say so in 'blockers' and set tests_pass false rather than claiming success.`,
    { label: `${task.id} build`, phase: 'Build', agentType: task.role, model: 'sonnet', schema: BUILD })

  if (!build || !build.tests_pass) {
    log(`${task.id}: BUILD RED — stopping the mission rather than building the next task on it`)
    return { status: 'BLOCKED', at: task.id, stage: 'build', detail: build ? build.blockers : 'agent died', results }
  }

  phase('Review')
  const review = await agent(
    `Review task ${task.id} of Octobots mission M7 in ${REPO}.
Diff: git diff ${HEAD}...${branch}   PR: ${build.pr_url || `(gh pr list --head ${branch})`}
Spec: ${PLAN} section "### Task ${task.planTask}:"   Criteria: ${board}

${RULES}

REVIEW FOR, in priority order:
1. CLAIMS. This campaign's single recurring defect is a claim that outran what the code computed —
   a clusterIds field hardcoded to a constant, a count saying "21 files" while meaning something
   narrower, a rendered edge naming a module with no heading, a --since window missing from
   provenance. Every one passed its tests. M7 renders a NEW set of claims into a committed
   artifact: a set's name, its file count, the modules it spans. Check each against what actually
   produced it. A header stating "10 files across a, b" above nine lines is this defect exactly.
2. REACHABILITY, not just correctness. For every branch and guard, ask what input reaches it — and
   whether any can. A condition no value satisfies reads perfectly and does nothing. Note that the
   two-file noise guard here is deliberately narrow and its comment must not claim to handle
   test-subject pairs, which structurally cannot reach it.
3. DETERMINISM. Unsorted Map/Set iteration reaching output, a non-total comparator, locale
   collation, a clock. map.md is committed; churn destroys its purpose.
4. A DUPLICATED RULE IS BLOCKING, not a nit. Does this re-implement classifyPair, isTestPath,
   compare, edgeWeight or the thin-history comparison? Five modules each open-coding one weighting
   rule, with one disagreeing, is how M1 emitted an architectural dependency asserted from evidence
   of its own absence.
5. The acceptance criteria: for each, find the code that satisfies it and challenge it.

REMEDIATE IN PLACE: fix each blocking finding yourself, add THE REGRESSION TEST that would have
caught it, re-run test/typecheck/lint green, commit scoped and push. Return 'fixed' separately from
'stillOpen'. A fixed finding is the gate working, not a failure — set final_state_green on the
state of the tree when you finish, not on whether you found anything.`,
    { label: `${task.id} review`, phase: 'Review', agentType: 'tech-lead', model: 'opus', schema: REVIEW })

  if (!review || !review.final_state_green) {
    log(`${task.id}: REVIEW RED — stopping`)
    return { status: 'BLOCKED', at: task.id, stage: 'review', detail: review ? review.summary : 'agent died', results }
  }

  phase('Verify')
  const retryNote = task.n === 1 ? `
PRIOR ATTEMPT (2026-08-10): an earlier verify of this task blocked, correctly, on red CI. Two
defects have since been fixed on this branch in commit b9d1bf9:
  - .github/workflows/ci.yml now checks out with fetch-depth: 0. It previously took a 1-commit
    shallow clone, so harvest() saw no history and the live-history tests failed deterministically.
  - the two live-history tests in test/working-sets.test.ts now pin minCommits explicitly, because
    this repo has 68 analysable commits against a default minCommits of 200 — so T7.2's upcoming
    thin-history suppression would otherwise have emptied workingSets and broken them again.
Verify all of this yourself from scratch. Do NOT assume the earlier block still stands, and do NOT
assume the fix is correct because someone reported it was. Re-run everything.
` : ''

  const land = await agent(
    `You own the merge gate for task ${task.id} of Octobots mission M7 in ${REPO}.
Branch ${branch}, base ${HEAD}, PR ${build.pr_url || `(gh pr list --head ${branch})`}.
${retryNote}
READ THE CRITERIA FRESH from ${board}. They may have been corrected since an earlier attempt: a
criterion that contradicts an approved design decision is a board defect, and blocking on one is
correct — it happened on T3.1, whose criterion still demanded "test files never appear as module
members" after the owner had reversed that policy to "marked, not withheld". Judge against what the
file says NOW.

VERIFY INDEPENDENTLY — take neither the developer's nor the reviewer's word:
1. git checkout ${branch} && git pull --ff-only
2. Run and capture: pnpm --filter @octoshell/graph test / typecheck / lint. Every pre-existing test
   must still pass alongside the new ones.
3. Read the acceptance criteria. For EACH, decide pass/fail with concrete evidence — a named test,
   an observed value. A criterion with no evidence is a FAIL, not a pass. A passing suite is
   evidence about the suite, not about a criterion.
${task.foundation ? `4. THIS IS A FOUNDATION TASK — later tasks consume it, so a defect here is inherited silently by
   everything built on it. Verify BLACK-BOX: build the package and drive the built dist/ from
   throwaway probes in a temp directory, constructing inputs the unit tests do not. Do not read
   src/. Where this task writes a file, assert against THE FILE ON DISK, never the in-memory value.
   Delete your probes; do not commit them.` : `4. Leaf task — the static gate is sufficient: suites, lint, type-check, criteria by inspection.
   Where a criterion is about rendered output, read the rendered output rather than the code.`}

IF EVERYTHING PASSES:
5. node .claude/skills/mission-planner/scripts/set-criterion.js ${board} check <n>   (1-based, in order)
6. node .claude/skills/mission-planner/scripts/set-status.js ${MDIR} "<the task's exact name field>" done
7. .octobots/ is gitignored — those board edits are local-only. Do NOT commit them and never reach
   for 'git add -A' when nothing appears staged.
8. CI must be green on the PR before you merge. Local green is not sufficient evidence: the last
   three CI failures on this repo did not reproduce locally at all.
9. gh pr merge <url> --squash --delete-branch, then git checkout ${HEAD} && git pull --ff-only

IF ANYTHING FAILS: do NOT merge. Set passed false, list the failures precisely, and stop.

${RULES}`,
    { label: `${task.id} verify+land`, phase: 'Verify', agentType: 'qa-engineer', model: 'sonnet', schema: LAND })

  if (!land || !land.passed || !land.merged) {
    log(`${task.id}: VERIFY/MERGE RED — stopping`)
    return { status: 'BLOCKED', at: task.id, stage: 'verify', detail: land ? land.failures : 'agent died', results }
  }

  log(`${task.id} merged — ${land.pr_url || build.pr_url || ''}`)
  results.push({ task: task.id, ok: true, pr: land.pr_url || build.pr_url, findings_fixed: review.fixed.length })
}

// Landed tasks are not a green mission. Nothing has yet verified the MISSION's eight criteria, and
// nothing has seen the four PRs together.
phase('Gate')
log('all tasks merged — handing to the mission-completion gate')
return { status: 'MISSION_TASKS_MERGED', results, next: 'mission-completion-gate', head: HEAD, base: BASE }
