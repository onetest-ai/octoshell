export const meta = {
  name: "build-and-gate",
  description: "Drive M3's six tasks to a gated, verified done: sequential build+review+verify per task, then one mission gate",
  phases: [
    { title: "Run", steps: [
      {"id":"s1","agent":"claude","label":"build-and-gate"},
    ] },
    { title: "Build", steps: [
      {"id":"t1","agent":"js-dev","label":"Noise floor and drift"},
      {"id":"t2","agent":"js-dev","label":"Doctor: ok/degraded/blocked","dependsOn":["t1"]},
      {"id":"t3","agent":"js-dev","label":"clusters.json round-trip","dependsOn":["t2"]},
      {"id":"t4","agent":"js-dev","label":"Cluster-id stability wired","dependsOn":["t3"]},
      {"id":"t5","agent":"js-dev","label":"CLI and pack bundle","dependsOn":["t4"]},
      {"id":"t6","agent":"qa-engineer","label":"End-to-end regression tests","dependsOn":["t5"]},
    ] },
    { title: "Review", steps: [
      {"id":"rv","agent":"tech-lead","label":"Review task diff, remediate in place","dependsOn":["t6"]},
    ] },
    { title: "Verify", steps: [
      {"id":"vf","agent":"qa-engineer","label":"Black-box verify, check criteria, merge","dependsOn":["rv"]},
    ] },
    { title: "Gate", steps: [
      {"id":"g1","agent":"js-dev","label":"Tests and new-code coverage","dependsOn":["vf"]},
      {"id":"g2","agent":"qa-engineer","label":"Black-box QA vs mission criteria","parallel":"g","dependsOn":["g1"]},
      {"id":"g3","agent":"tech-lead","label":"Whole-mission review","parallel":"g","dependsOn":["g1"]},
    ] },
  ],
}

// ---------------------------------------------------------------------------
// Body. `meta` above is the picture; this is the program. The loops and the
// `return { blocked }` guards ARE the design — a run that only walks
// Build -> Review -> Verify -> Gate assumes every stage passes first time, and
// that optimism is what makes a red run read as done.
// ---------------------------------------------------------------------------

const REPO = '/Users/arozumenko/Development/octoshell'
const BASE = 'feat/octograph-code-architecture-graph'
const HEAD = 'feat/octograph-code-architecture-graph-m3'
const MDIR = '.octobots/campaigns/octograph-code-architecture-graph/missions/m3-drift-doctor-and-the-shipped-cli'

// planTask maps a board task onto its "### Task N:" section in the mission's design.md.
// T3.1's noise floor already shipped early with M2's A8 fix, so it is a smaller task than
// planned — say so rather than let an agent rebuild what exists.
const TASKS = [
  { id: 'T3.1', n: 1, slug: 't3-1-noise-floor-and-drift',                    role: 'js-dev',      planTask: 13, note: 'noise.ts and isTestPath ALREADY EXIST (they came forward with M2\'s A8 fix, commits 45a9cb4/178c8f8). Do NOT re-author them and do NOT write a second isTestPath — import the existing one. What is missing is drift.ts itself.' },
  { id: 'T3.2', n: 2, slug: 't3-2-doctor-with-ok-degraded-and-blocked-sta',  role: 'js-dev',      planTask: 14, note: '' },
  { id: 'T3.3', n: 3, slug: 't3-3-clusters-json-round-trip',                 role: 'js-dev',      planTask: 15, note: 'FOUNDATION: T3.4, T3.5 and T3.6 all consume this. The artifact is clusters.json — graph.json is Graphify\'s INPUT and is not ours to write.' },
  { id: 'T3.4', n: 4, slug: 't3-4-cluster-id-stability-wired-end-to-end',    role: 'js-dev',      planTask: null, note: 'FOUNDATION. Analysis.clusterIds was DELETED in M2 because it reported a hardcoded {kept:0,fresh:N}. Reintroduce it ONLY wired to stability.ts\'s real Jaccard remap. A placeholder must fail its criteria, which require the numbers to differ between an unchanged rerun and an altered-history rerun.' },
  { id: 'T3.5', n: 5, slug: 't3-5-cli-and-the-pack-bundle',                  role: 'js-dev',      planTask: null, note: 'Flag names are declared explicitly, never derived from field names — deriving them once produced --half-life-days while the spec documents --half-life, and an unrecognised flag was silently ignored. --out must be containment-checked through the SAME insideRepo helper octograph.yaml\'s out: already uses.' },
  { id: 'T3.6', n: 6, slug: 't3-6-end-to-end-noise-floor-doctor-exit-code',  role: 'qa-engineer', planTask: null, note: 'Assert against artifacts ON DISK, not in-memory values. M2 fixed one dangling-reference defect three times because every fix was pinned over the in-memory Analysis and never over the file that gets committed.' },
]

const RULES = `
NON-NEGOTIABLE (violating any of these fails the task):
- Work in ${REPO}. ONE working tree, branches only. NEVER 'git worktree add'.
- SCOPED STAGING: 'git add <exact paths>'. NEVER 'git add -A' — .octobots/ is gitignored and the
  tree may hold another agent's edits.
- ESM + NodeNext: every relative import carries a .js extension. strict +
  noUncheckedIndexedAccess; never a non-null assertion (!) to silence them.
- Determinism: no Date.now(), no Math.random() in graph computation, and any iteration order that
  reaches output must be explicitly sorted. Output is a COMMITTED artifact; churn destroys it.
- Read edge weights only through edgeWeight(); order only through compare(). NEVER localeCompare —
  it collates by the machine's locale, so a committed artifact reorders on a change of LANG.
- Reuse the single spelling of a rule: isTestPath (noise.ts), insideRepo (paths.ts), compare and
  edgeWeight (rollup/weights). conventions.test.ts guards this; a second spelling is a defect, not
  a style choice. It is how M1 shipped negative module edges.
- Fixture repos MUST use mkdtempClean — never a bare mkdtempSync. The suite leaked 2,502 repos and
  1.2GB before that landed, and it only ever failed on CI.
- Trailer: Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
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
  const spec = task.planTask
    ? `${MDIR}/design.md — the section "### Task ${task.planTask}:". If grep returns nothing on that file it contains a NUL byte and grep is treating it as binary: use 'grep -a', awk or Read before concluding a section is missing.`
    : `${board} — this task has no plan section; its description and acceptance criteria ARE the spec.`

  phase('Build')
  const build = await agent(
    `Build task ${task.id} of Octobots mission M3 (drift, doctor and the shipped CLI) in ${REPO}.

SPEC: ${spec}
SCOPE AND OUT-OF-SCOPE: ${board} — read the description, it says what this task does NOT cover.
${task.note ? `\nSPECIFIC TO THIS TASK: ${task.note}\n` : ''}
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
    `Review task ${task.id} of Octobots mission M3 in ${REPO}.
Diff: git diff ${HEAD}...${branch}   PR: ${build.pr_url || `(gh pr list --head ${branch})`}
Spec: ${spec}   Criteria: ${board}

${RULES}

REVIEW FOR, in priority order:
1. REACHABILITY, not just correctness. For every branch, guard and early return, ask what input
   reaches it — and whether any can. A condition no value satisfies reads perfectly and does
   nothing. This mission's own plan once specified exactly that: a manifest fallback pushed "."
   and the guard below it excluded ".", so the fallback was dead code that shipped and was caught
   only by black-box QA.
2. DETERMINISM. Unsorted Map/Set iteration reaching output, a non-total comparator, locale
   collation, a clock. The output is committed; churn destroys its purpose.
3. A DUPLICATED RULE IS BLOCKING, not a nit. Does this re-implement isTestPath, insideRepo,
   compare or edgeWeight? Five modules each open-coding one weighting rule, with one disagreeing,
   is how M1 emitted an architectural dependency asserted from evidence of its own absence.
4. CLAIMS. Every label, count and field in rendered or persisted output is a claim. Check each
   against what actually produced it. A count that mixes two things, or a field reporting a value
   no computation produced, is the defect class this campaign has hit most.
5. The acceptance criteria: for each, find the code that satisfies it and challenge it.
6. Security lens on path handling and anything reading outside the repo root.

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
  const foundation = /FOUNDATION/.test(task.note)
  const land = await agent(
    `You own the merge gate for task ${task.id} of Octobots mission M3 in ${REPO}.
Branch ${branch}, base ${HEAD}, PR ${build.pr_url || `(gh pr list --head ${branch})`}.

READ THE CRITERIA FRESH. They may have been corrected since an earlier attempt: a criterion that
contradicts an approved design decision is a board defect, and blocking on one is correct — it
happened on T3.1, whose AC4 still demanded "test files never appear as module members" after the
owner had reversed that policy to "marked, not withheld". Judge against what ${board} says NOW.

VERIFY INDEPENDENTLY — take neither the developer's nor the reviewer's word:
1. git checkout ${branch} && git pull --ff-only
2. Run and capture: pnpm --filter @octoshell/graph test / typecheck / lint. Every pre-existing test
   must still pass alongside the new ones.
3. Read the acceptance criteria in ${board}. For EACH, decide pass/fail with concrete evidence — a
   named test, an observed value. A criterion with no evidence is a FAIL, not a pass. A passing
   suite is evidence about the suite, not about a criterion.
${foundation ? `4. THIS IS A FOUNDATION TASK — later tasks consume it, so a defect here is inherited silently by
   everything built on it. Verify BLACK-BOX: build the package and drive the built dist/ from
   throwaway probes in a temp directory, constructing inputs the unit tests do not. Do not read
   src/. Where this task writes a file, assert against THE FILE ON DISK, never the in-memory value.
   Delete your probes; do not commit them.` : `4. Leaf task — the static gate is sufficient: suites, lint, type-check, criteria by inspection.`}

IF EVERYTHING PASSES:
5. node .claude/skills/mission-planner/scripts/set-criterion.js ${board} check <n>   (1-based, in order)
6. node .claude/skills/mission-planner/scripts/set-status.js ${MDIR} "<the task's exact name field>" done
7. .octobots/ is gitignored — those board edits are local-only. Do NOT commit them and never reach
   for 'git add -A' when nothing appears staged.
8. gh pr merge <url> --squash --delete-branch, then git checkout ${HEAD} && git pull --ff-only
9. CI must be green on the PR before you merge. Local green is not sufficient evidence: the last
   three CI failures on this repo did not reproduce locally at all.

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
// nothing has seen the six PRs together.
phase('Gate')
log('all tasks merged — handing to the mission-completion gate')
return { status: 'MISSION_TASKS_MERGED', results, next: 'mission-completion-gate', head: HEAD, base: BASE }
