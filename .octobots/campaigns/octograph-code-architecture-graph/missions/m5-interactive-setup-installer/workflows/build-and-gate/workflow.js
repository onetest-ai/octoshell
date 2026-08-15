export const meta = {
  name: "build-and-gate",
  description: "Drive M5's three tasks to a gated, verified done: sequential build+review+verify per task, then one mission gate",
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
const HEAD = 'feat/octograph-code-architecture-graph-m5'
const MDIR = '.octobots/campaigns/octograph-code-architecture-graph/missions/m5-interactive-setup-installer'
const PLAN = 'docs/superpowers/plans/2026-08-10-octograph-setup-installer.md'

const TASKS = [
  { id: 'T5.1', n: 1, slug: 't5-1-the-io-port-and-the-setup-flow-installing-not', role: 'js-dev', planTask: 1, foundation: true, note:
    'FOUNDATION: every other task builds on the port.\n'
    + 'setup is NOT a runCli command. runCli(argv, repoRoot, now) is synchronous and never touches\n'
    + 'process — index.ts records that this is exactly so M6 can call it in-process — and prompting is\n'
    + 'async. Export runSetup(repoRoot, config, now, io) instead.\n'
    + '`now` is a PARAMETER. analyze()\'s AnalyzeOptions.now is required with no default, and\n'
    + 'conventions.test.ts scans every file under src/ for a clock read with no exemption list, so\n'
    + 'Date.now() inside setup.ts fails the build. bin/octograph.mjs is the one sanctioned clock read\n'
    + 'and it already supplies runCli\'s now the same way.\n'
    + 'The build step calls the SAME function map calls. runMapCommand is private to cli.ts today —\n'
    + 'export a shared buildMap (or runMapCommand) rather than reassembling analyze/renderMap/\n'
    + 'writeArtifact by hand. A second copy of that sequence is the entity-io.mjs vs entity-schema.ts\n'
    + 'shape, which is the defect this whole tool exists to detect.\n'
    + 'setup-io.ts gets its OWN unit test. It is the safety-critical module and every other test in\n'
    + 'this mission replaces it with a fake, so without a direct test the real execFile/readline/which\n'
    + 'wiring is never exercised anywhere.' },

  { id: 'T5.2', n: 2, slug: 't5-2-missing-uv-and-safety-rules-with-no-override', role: 'js-dev', planTask: 2, foundation: false, note:
    'The source-text guard targets setup-io.ts, NOT setup.ts. By the architecture, setup.ts only ever\n'
    + 'calls io.exec with a literal command and an argv array, so it CANNOT contain "curl", "|" or\n'
    + '"sh -c" — a guard aimed there passes forever no matter what the spawning code does. That is\n'
    + 'theatre, not a guard. Scan the file that can actually violate the rule, for the primitives that\n'
    + 'would actually violate it: child_process.exec(, spawn with shell:true, any { shell: true }, or a\n'
    + 'spawn whose args are not a literal array. Model it on conventions.test.ts.\n'
    + 'uv tool install graphifyy — the double-y is CORRECT. The GitHub repo is Graphify-Labs/graphify;\n'
    + 'the published package is graphifyy. A QA pass already flagged it once as a typo. Do not fix it.' },

  { id: 'T5.4', n: 4, slug: 't5-4-end-to-end-consent-refusal-absent-uv-a-clean', role: 'qa-engineer', planTask: 4, foundation: false, note:
    'Drive the REAL bin with scripted stdin, not runSetup directly. Note test/fixtures/run-node.ts\'s\n'
    + 'runNode helper takes no stdin today — extend it with execFileSync\'s input option.\n'
    + 'VERIFY THE BUILD, not just the postflight: a full-consent run must produce a map.md and\n'
    + 'clusters.json equal to what `map` alone produces at the same now. Every other check in this\n'
    + 'mission tests prompts, installs and exit codes; a postflight reporting a state it never\n'
    + 'verified is this campaign\'s defect and it has shipped six times.\n'
    + 'NEVER perform a real `uv tool install`. The suite must pass offline, on a machine with no uv,\n'
    + 'without mutating the developer\'s tooling.' },
]

const RULES = `
NON-NEGOTIABLE (violating any of these fails the task):
- Work in ${REPO}. ONE working tree, branches only. NEVER 'git worktree add'.
- SCOPED STAGING: 'git add <exact paths>'. NEVER 'git add -A' — .octobots/ and .claude/ are
  gitignored and the tree may hold another agent's edits.
- ESM + NodeNext: every relative import carries a .js extension. strict +
  noUncheckedIndexedAccess; never a non-null assertion (!) to silence them.
- NEVER pipe a remote script to a shell, under any flag. NEVER spawn through a shell — execFile
  with an argv array, so there is no string for an interpolated value to escape out of.
- PROMPT before installing anything. There is deliberately no --yes flag: a flag that skips the
  prompt is the exact affordance criterion 1 forbids. M6 opens a real terminal for the human, and
  a CI image that wants Graphify runs 'uv tool install graphifyy' in its own Dockerfile.
- NEVER install into the repo. Graphify is a user-level tool.
- No clock read anywhere under src/ — 'now' is passed in from the bin.
- Determinism: no Math.random(); any iteration order reaching output explicitly sorted through
  compare(). Read weights only through edgeWeight(). NEVER localeCompare.
- Reuse the single spelling of a rule: isTestPath and classifyPair (noise.ts), insideRepo
  (paths.ts), compare and edgeWeight (rollup/weights), historyIsThin (config.ts),
  isSyntheticBridge (components.ts). conventions.test.ts guards these.
- Fixture repos MUST use mkdtempClean — never a bare mkdtempSync.
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
    `Build task ${task.id} of Octobots mission M5 (the interactive setup installer) in ${REPO}.

WHAT M5 IS. octograph is a git-history co-change architecture graph in packages/graph. M1-M4 and M7
shipped map, impact, drift, doctor, own, conflicts, working sets and a self-contained esbuild bundle
that runs under bare node with no node_modules. M5 adds 'setup': run doctor, prompt before
installing anything, install Graphify via uv on consent, build, print the postflight.

IT IS THE ONLY COMPONENT THAT MUTATES THE USER'S MACHINE. That is why its safety rules are absolute
and why they are enforced by tests rather than by review.

SPEC: ${PLAN} — read the whole header (Global Constraints, "The structural decision this mission
turns on") and then the section "### Task ${task.planTask}:".
SCOPE AND OUT-OF-SCOPE: ${board} — the description says what this task does NOT cover, and its
acceptance criteria are the contract you are judged against.

SPECIFIC TO THIS TASK:
${task.note}

Also read ${REPO}/CLAUDE.md, ${REPO}/AGENTS.md and ${REPO}/.agents/knowledge/.

${RULES}

STEPS:
1. git checkout ${HEAD} && git pull --ff-only && git checkout -b ${branch}
2. TDD: write the failing test, RUN IT and confirm it fails for the right reason, implement, green.
3. All green before you finish, and every pre-existing test must still pass:
     pnpm --filter @octoshell/graph test / typecheck / lint
   plus a whole-repo 'pnpm build' if you touched public types or the bin.
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
    `Review task ${task.id} of Octobots mission M5 in ${REPO}.
Diff: git diff ${HEAD}...${branch}   PR: ${build.pr_url || `(gh pr list --head ${branch})`}
Spec: ${PLAN} section "### Task ${task.planTask}:"   Criteria: ${board}

${RULES}

REVIEW FOR, in priority order:
1. SAFETY, because this is the one component that mutates the user's machine. Can anything reach a
   shell? Can any interpolated value escape into a command? Is there any path that installs without
   an explicit yes — including on a retry, a re-run, or an error path? Does a failure ever leave the
   machine half-changed with no way to tell?
2. GUARDS THAT ACTUALLY GUARD. A source-text assertion over a file that cannot contain the string it
   scans for is theatre, and this mission's own plan shipped exactly that mistake in an early draft:
   it scanned setup.ts, which by construction never touches child_process. For every guard here, ask
   what edit it would actually catch. If the answer is "none", it is worse than no guard because it
   reads as coverage.
3. CLAIMS. This campaign's one recurring defect is a claim that outran what the code computed, and
   it has shipped six times — a clusterIds field hardcoded to a constant; a count meaning something
   narrower than it said; an edge naming a module with no heading; a --since window missing from
   provenance; a working set spanning modules on zero commits; 'own' silently dropping 9 of 17
   provenance records; '(no conflicts found)' meaning both "clean" and "I had nothing to say".
   M5's version is a POSTFLIGHT that reports an install, a build, or a state it did not verify.
   Audit every line the postflight prints against what was actually observed.
4. A DUPLICATED RULE IS BLOCKING. Does the build step re-implement what map does rather than calling
   it? Does anything re-spell a rule that already has one spelling?
5. The acceptance criteria: for each, find the code that satisfies it and challenge it.

REMEDIATE IN PLACE: fix each blocking finding yourself, add THE REGRESSION TEST that would have
caught it, re-run test/typecheck/lint green, commit scoped and push. Return 'fixed' separately from
'stillOpen'. Set final_state_green on the state of the tree when you finish, not on whether you
found anything.`,
    { label: `${task.id} review`, phase: 'Review', agentType: 'tech-lead', model: 'opus', schema: REVIEW })

  if (!review || !review.final_state_green) {
    log(`${task.id}: REVIEW RED — stopping`)
    return { status: 'BLOCKED', at: task.id, stage: 'review', detail: review ? review.summary : 'agent died', results }
  }

  phase('Verify')
  const land = await agent(
    `You own the merge gate for task ${task.id} of Octobots mission M5 in ${REPO}.
Branch ${branch}, base ${HEAD}, PR ${build.pr_url || `(gh pr list --head ${branch})`}.

READ THE CRITERIA FRESH from ${board}. A criterion that contradicts an approved design decision is a
board defect and blocking on one is correct — that happened on T3.1, whose criterion still demanded
"test files never appear as module members" after the owner had reversed that policy. Judge against
what the file says NOW. Note that M5's criterion 3 carries NO exception: the migration task (T5.3)
was cancelled on 2026-08-11, and with it the carve-out that had briefly let setup delete the artifact
directory a clean migration moved from. Criterion 3 is absolute — setup touches no tracked file at
all outside the resolved out directory, and there is nothing it may remove.

VERIFY INDEPENDENTLY — take neither the developer's nor the reviewer's word:
1. git checkout ${branch} && git pull --ff-only
2. Run and capture: pnpm --filter @octoshell/graph test / typecheck / lint, plus 'pnpm build' if the
   diff touches public types or the bin. Every pre-existing test must still pass.
3. For EACH acceptance criterion, decide pass/fail with concrete evidence — a named test, an
   observed value. A criterion with no evidence is a FAIL. A passing suite is evidence about the
   suite, not about a criterion.
4. NEVER run a real 'uv tool install' while verifying, and do not let a test do it either. If you
   find one that would, that is a blocking failure, not a note.
${task.foundation ? `5. THIS IS A FOUNDATION TASK — later tasks consume it, so a defect here is inherited silently.
   Verify BLACK-BOX: build the package and drive the built dist/ from throwaway probes in a temp
   directory, constructing inputs the unit tests do not. Do not read src/. Delete your probes.` : `5. Leaf task — the static gate is sufficient: suites, lint, type-check, criteria by inspection.
   Where a criterion is about observable behaviour, observe it rather than reading the code.`}

IF EVERYTHING PASSES:
6. node .claude/skills/mission-planner/scripts/set-criterion.js ${board} check <n>   (1-based, in order)
7. node .claude/skills/mission-planner/scripts/set-status.js ${MDIR} "<the task's exact name field>" done
8. .octobots/ is gitignored — those board edits are local-only. Do NOT commit them and never reach
   for 'git add -A' when nothing appears staged.
9. CI must be green on the PR before you merge. Local green is not sufficient evidence: several CI
   failures on this repo never reproduced locally. There is also a documented intermittent e2e
   fixture failure — if you hit it, say so explicitly rather than retrying quietly until green.
10. gh pr merge <url> --squash --delete-branch, then git checkout ${HEAD} && git pull --ff-only

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

// Landed tasks are not a green mission. M7's whole-mission review found two blocking defects that
// four task reviews and a black-box QA pass had all cleared; M4's found five.
phase('Gate')
log('all tasks merged — handing to the mission-completion gate')
return { status: 'MISSION_TASKS_MERGED', results, next: 'mission-completion-gate', head: HEAD, base: BASE }
