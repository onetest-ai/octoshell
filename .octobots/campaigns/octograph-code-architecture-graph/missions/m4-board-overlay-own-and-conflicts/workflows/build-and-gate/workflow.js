export const meta = {
  name: "build-and-gate",
  description: "Drive M4's six tasks to a gated, verified done: sequential build+review+verify per task, then one mission gate",
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

const REPO = '/Users/arozumenko/Development/octoshell'
const BASE = 'feat/octograph-code-architecture-graph'
const HEAD = 'feat/octograph-code-architecture-graph-m4'
const MDIR = '.octobots/campaigns/octograph-code-architecture-graph/missions/m4-board-overlay-own-and-conflicts'
const PLAN = 'docs/superpowers/plans/2026-08-10-octograph-board-overlay.md'

const TASKS = [
  { id: 'T4.1', n: 1, slug: 't4-1-board-and-worklog-readers', role: 'js-dev', planTask: 1, foundation: true, note:
    'FOUNDATION: every other task consumes these readers.\n'
    + '@octoshell/board\'s public Task.acceptanceCriteria is a STRING — a rendered "- [ ] text"\n'
    + 'checklist, not a structured array. There is no AcceptanceCriterion[] on the public type. Parse\n'
    + 'the checklist back into lines and comment WHY: it is format-agnostic across legacy .md and\n'
    + 'current YAML boards, which re-reading task.yaml directly would not be.\n'
    + 'Do NOT deep-import into packages/board/src — use its index exports only.\n'
    + 'Measure the bundle before and after with `pnpm --filter @octoshell/graph bundle` and report\n'
    + 'both byte sizes. The campaign ceiling is ~500 KB; above it, own/conflicts become library-only\n'
    + 'and that is the owner\'s call, not yours to make silently.' },

  { id: 'T4.2', n: 2, slug: 't4-2-merge-sha-capture-at-the-gate-and-provenance', role: 'js-dev', planTask: 2, foundation: true, note:
    'FOUNDATION: T4.3 calibrates its threshold against the dataset this task produces.\n'
    + 'READ THE PLAN SECTION CAREFULLY — there is NO merge-time worklog write to add a field to.\n'
    + 'hooks/work-log.mjs:74 is `if (!command.includes("set-status.js")) process.exit(0)`, and\n'
    + 'mission-execution flips task status BEFORE merging the PR. At the only moment the worklog is\n'
    + 'written, the PR is still open and no merge SHA exists anywhere. The capture point is the\n'
    + 'mission gate\'s Tokenomics phase.\n'
    + 'AttributionMode has exactly TWO members. Do not add commit-subject scanning — it was\n'
    + 'considered and rejected because all 13 lost branches are recoverable through the GitHub API.\n'
    + 'The pack lives at apps/vscode-extension/resources/octobots-pack/ and is installed into\n'
    + '.claude/ — edit the SHIPPED copy under resources/, and bump the pack version everywhere it is\n'
    + 'recorded (4 SKILL.md files, primer.mjs, run.mjs, octobots-skill.ts).' },

  { id: 'T4.3', n: 3, slug: 't4-3-lexical-cold-start-predictor-with-a-measured', role: 'js-dev', planTask: 3, foundation: false, note:
    'The threshold is MEASURED, not invented. Every other tunable in this package is a pinned\n'
    + 'constant with a stated rationale (minSupport 2, hubZThreshold 3, halfLifeDays 180, the 0.5\n'
    + 'Jaccard bar). Calibrate against the tasks T4.2 attributed by provenance — they are a labelled\n'
    + 'dataset — and REPORT precision, recall and sample size. A threshold fitted to roughly a dozen\n'
    + 'samples is a weak prior: say so in the comment rather than presenting it as tuned.' },

  { id: 'T4.4', n: 4, slug: 't4-4-the-own-command', role: 'js-dev', planTask: 4, foundation: false, note:
    'runCli accepts a positional only for `impact` today and rejects them for every other command,\n'
    + 'so `own [<path>]` needs explicit handling in the declared parser. Flags are declared\n'
    + 'explicitly, never derived from field names — deriving them once produced --half-life-days\n'
    + 'while the spec documents --half-life, and an unrecognised flag was silently ignored.' },

  { id: 'T4.5', n: 5, slug: 't4-5-the-conflicts-command', role: 'js-dev', planTask: 5, foundation: false, note:
    'The spec says "summed nPMI over predicted surfaces", and that ALONE is wrong: weighEdges never\n'
    + 'emits a self-pair and rollUp drops self-loops, so two tasks predicting the SAME file — the\n'
    + 'clearest decomposition conflict there is — sum to zero. Report `shared` and `coupled` as\n'
    + 'SEPARATE fields, never blended into one score. One number meaning two things is the "21 files"\n'
    + 'defect and the edge-weight-unit defect, both of which shipped in this campaign.' },

  { id: 'T4.6', n: 6, slug: 't4-6-end-to-end-no-board-day-one-board-and-a-mode', role: 'qa-engineer', planTask: 6, foundation: false, note:
    'Assert against RENDERED command output on disk, driven through the shipped bundle — never an\n'
    + 'in-memory value. M2 fixed one dangling-reference defect three times because every fix was\n'
    + 'pinned over the in-memory Analysis instead of the artifact that gets committed.' },
]

const RULES = `
NON-NEGOTIABLE (violating any of these fails the task):
- Work in ${REPO}. ONE working tree, branches only. NEVER 'git worktree add'.
- SCOPED STAGING: 'git add <exact paths>'. NEVER 'git add -A' — .octobots/ and .claude/ are
  gitignored and the tree may hold another agent's edits.
- ESM + NodeNext: every relative import carries a .js extension. strict +
  noUncheckedIndexedAccess; never a non-null assertion (!) to silence them.
- Determinism: no Date.now(), no Math.random() in graph computation, and any iteration order that
  reaches output must be explicitly sorted. Output is a COMMITTED artifact; churn destroys it.
- Read edge weights only through edgeWeight(); order only through compare(). NEVER localeCompare.
  Skip synthetic bridges through isSyntheticBridge() — a support:0 bridge is not evidence of
  coupling, and M7 shipped a cross-module claim backed by zero commits by forgetting exactly that.
- Reuse the single spelling of a rule: isTestPath and classifyPair (noise.ts), insideRepo
  (paths.ts), compare and edgeWeight (rollup/weights), historyIsThin (config.ts),
  isSyntheticBridge (components.ts). conventions.test.ts guards these.
- Fixture repos MUST use mkdtempClean — never a bare mkdtempSync. The suite leaked 2,502 repos and
  1.2GB before that landed, and it only ever failed on CI.
- Anything a consumer needs is re-exported from src/index.ts or it does not exist outside the
  package. Two prior missions shipped whole subsystems that never reached that file.
- Rebuild @octoshell/board before typechecking @octoshell/graph — dependents read built dist/,
  not src/, so a public-type change is invisible until you build it.
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
    `Build task ${task.id} of Octobots mission M4 (board overlay — own and conflicts) in ${REPO}.

WHAT M4 IS. octograph is a git-history co-change architecture graph in packages/graph. M1-M3 and M7
shipped map, impact, drift, doctor, working sets and a self-contained esbuild bundle that runs under
bare node with no node_modules. M4 joins the graph to the Octobots board: 'own' answers which
mission owns a module and which criterion a file exists to satisfy; 'conflicts' answers whether a
mission's decomposition is clean.

SPEC: ${PLAN} — read the whole header (Global Constraints, "The finding that reshapes this mission")
and then the section "### Task ${task.planTask}:".
SCOPE AND OUT-OF-SCOPE: ${board} — the description says what this task does NOT cover, and its
acceptance criteria are the contract you are judged against.

SPECIFIC TO THIS TASK:
${task.note}

Also read ${REPO}/CLAUDE.md, ${REPO}/AGENTS.md and ${REPO}/.agents/knowledge/ — the knowledge layer
is short and every note in it was paid for.

${RULES}

STEPS:
1. git checkout ${HEAD} && git pull --ff-only && git checkout -b ${branch}
2. TDD: write the failing test, RUN IT and confirm it fails for the right reason, implement, green.
3. All green before you finish, and every pre-existing test must still pass:
     pnpm --filter @octoshell/graph test / typecheck / lint
   plus a whole-repo 'pnpm build' if you touched a package's public types or the pack.
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
    `Review task ${task.id} of Octobots mission M4 in ${REPO}.
Diff: git diff ${HEAD}...${branch}   PR: ${build.pr_url || `(gh pr list --head ${branch})`}
Spec: ${PLAN} section "### Task ${task.planTask}:"   Criteria: ${board}

${RULES}

REVIEW FOR, in priority order:
1. CLAIMS — this campaign's one recurring defect is a claim that outran what the code computed. It
   has now shipped five times: a clusterIds field hardcoded to a constant; a count saying "21 files"
   while meaning something narrower; a rendered edge naming a module with no heading; a --since
   window missing from provenance; and a working set claiming a cross-module span backed by zero
   commits. Every one passed its tests. M4's whole product IS a claim about where code came from —
   the word 'provenance' is a promise. Check every mode label against the evidence behind it. A
   lexical guess labelled provenance is this defect in its purest form.
2. REACHABILITY. For every branch and guard, ask what input reaches it, and whether any can. A
   condition no value satisfies reads perfectly and does nothing.
3. DETERMINISM. Unsorted Map/Set iteration reaching output, a non-total comparator, locale
   collation, a clock.
4. A DUPLICATED RULE IS BLOCKING, not a nit. Does this re-implement classifyPair, isTestPath,
   compare, edgeWeight, historyIsThin or isSyntheticBridge? Does it parse .octobots YAML rather than
   going through @octoshell/board? A second spelling of the board schema is the exact defect this
   tool exists to detect.
5. SECURITY. This task reads a JSONL log, spawns 'gh', and renders paths into output. Untrusted-ish
   input reaches all three. M7 shipped a defect where a newline in a filename injected a phantom
   line into rendered markdown — check that class here too.
6. The acceptance criteria: for each, find the code that satisfies it and challenge it.

REMEDIATE IN PLACE: fix each blocking finding yourself, add THE REGRESSION TEST that would have
caught it, re-run test/typecheck/lint green, commit scoped and push. Return 'fixed' separately from
'stillOpen'. A fixed finding is the gate working — set final_state_green on the state of the tree
when you finish, not on whether you found anything.`,
    { label: `${task.id} review`, phase: 'Review', agentType: 'tech-lead', model: 'opus', schema: REVIEW })

  if (!review || !review.final_state_green) {
    log(`${task.id}: REVIEW RED — stopping`)
    return { status: 'BLOCKED', at: task.id, stage: 'review', detail: review ? review.summary : 'agent died', results }
  }

  phase('Verify')
  const land = await agent(
    `You own the merge gate for task ${task.id} of Octobots mission M4 in ${REPO}.
Branch ${branch}, base ${HEAD}, PR ${build.pr_url || `(gh pr list --head ${branch})`}.

READ THE CRITERIA FRESH from ${board}. A criterion that contradicts an approved design decision is a
board defect and blocking on one is correct — that happened on T3.1, whose criterion still demanded
"test files never appear as module members" after the owner had reversed that policy. Judge against
what the file says NOW.

VERIFY INDEPENDENTLY — take neither the developer's nor the reviewer's word:
1. git checkout ${branch} && git pull --ff-only
2. Run and capture: pnpm --filter @octoshell/graph test / typecheck / lint, and 'pnpm build' if the
   diff touches public types or the pack. Every pre-existing test must still pass.
3. For EACH acceptance criterion, decide pass/fail with concrete evidence — a named test, an
   observed value. A criterion with no evidence is a FAIL. A passing suite is evidence about the
   suite, not about a criterion.
${task.foundation ? `4. THIS IS A FOUNDATION TASK — later tasks consume it, so a defect here is inherited silently.
   Verify BLACK-BOX: build the package and drive the built dist/ from throwaway probes in a temp
   directory, constructing inputs the unit tests do not. Do not read src/. Where this task writes a
   file, assert against THE FILE ON DISK. Delete your probes; do not commit them.` : `4. Leaf task — the static gate is sufficient: suites, lint, type-check, criteria by inspection.
   Where a criterion is about rendered output, read the rendered output rather than the code.`}

IF EVERYTHING PASSES:
5. node .claude/skills/mission-planner/scripts/set-criterion.js ${board} check <n>   (1-based, in order)
6. node .claude/skills/mission-planner/scripts/set-status.js ${MDIR} "<the task's exact name field>" done
7. .octobots/ is gitignored — those board edits are local-only. Do NOT commit them and never reach
   for 'git add -A' when nothing appears staged.
8. CI must be green on the PR before you merge. Local green is not sufficient evidence: several CI
   failures on this repo did not reproduce locally at all — including a shallow-checkout failure
   that was invisible outside CI.
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

// Landed tasks are not a green mission. Nothing has yet verified the MISSION's criteria, and
// nothing has seen the six PRs together. M7's whole-mission review found two blocking defects that
// four task reviews and a black-box QA pass had all cleared.
phase('Gate')
log('all tasks merged — handing to the mission-completion gate')
return { status: 'MISSION_TASKS_MERGED', results, next: 'mission-completion-gate', head: HEAD, base: BASE }
