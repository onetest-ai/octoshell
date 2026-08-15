export const meta = {
  name: "build-and-gate",
  description: "Drive M6's five tasks to a gated, verified done: sequential build+review+verify per task, then one mission gate",
  phases: [
    { title: "Build", steps: [
      {"id":"t1","agent":"js-dev","label":"Pack payload and freshness check"},
      {"id":"t2","agent":"js-dev","label":"octograph.ts and the two validators","dependsOn":["t1"]},
      {"id":"t3","agent":"js-dev","label":"Install Graph and Rebuild Graph","dependsOn":["t2"]},
      {"id":"t4","agent":"js-dev","label":"primer.mjs injects map.md","dependsOn":["t3"]},
      {"id":"t5","agent":"qa-engineer","label":"End-to-end hazard suite","dependsOn":["t4"]},
    ] },
    { title: "Review", steps: [
      {"id":"rv","agent":"tech-lead","label":"Review task diff, remediate in place","dependsOn":["t5"]},
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

const REPO = '/Users/arozumenko/Development/octoshell'
const BASE = 'feat/octograph-code-architecture-graph'
const HEAD = 'feat/octograph-code-architecture-graph-m6'
const MDIR = '.octobots/campaigns/octograph-code-architecture-graph/missions/m6-extension-bridge'
const PLAN = 'docs/superpowers/plans/2026-08-11-octograph-extension-bridge.md'

const TASKS = [
  { id: 'T6.1', n: 1, slug: 't6-1-ship-the-bundle-as-pack-payload-and-make-a-st', role: 'js-dev', planTask: 1, foundation: true, note:
    'FOUNDATION AND BLOCKER: without this the other four tasks build a launcher for a file that is\n'
    + 'never there. Nothing installs the octograph bundle today — resources/octobots-pack/ has hooks,\n'
    + 'skill and tokenomics and no graph, and bundle.mjs writes only to packages/graph/dist.\n'
    + 'octobots-tokenomics.ts is a precedent for the install/status SHAPE ONLY. Its payload is a\n'
    + 'hand-written copy sharing no code with packages/tokenomics — the duplication bundle.mjs\'s own\n'
    + 'doc comment calls the anti-pattern octograph exists to avoid. Nothing in this repo ships a\n'
    + 'sibling package\'s BUILD OUTPUT as payload and verifies it fresh. This is novel work.\n'
    + 'The obvious placements do not work and the plan says why: `bundle` is not a turbo task, and\n'
    + 'package-vsix.yml is workflow_dispatch only, so a check there lets drift pass every PR.\n'
    + 'PROVE the check fires: corrupt the payload deliberately and watch the CI-gated command fail.\n'
    + 'A criterion satisfied by pointing at where a check lives is the defect this campaign keeps\n'
    + 'shipping.' },

  { id: 'T6.2', n: 2, slug: 't6-2-octograph-ts-pure-command-construction-with-t', role: 'js-dev', planTask: 2, foundation: true, note:
    'TWO validators, and the reason is the whole task. Task ids get the safe-slug pattern\n'
    + 'sdlc-bundles.ts already has. Paths do NOT: real paths carry /, ., - and sometimes spaces, and\n'
    + 'loosening the slug pattern to admit them would quietly gut the injection guard it exists to\n'
    + 'provide. Resolve, assert inside the workspace root, reject shell metacharacters, pass as a\n'
    + 'separate argv element — never interpolate into a command string.\n'
    + 'packages/graph/src/paths.ts insideRepo CANNOT be imported: criterion 4 forbids the dependency.\n'
    + 'So this is a SECOND SPELLING of a containment rule. Make it visible, not silent: cross-\n'
    + 'reference paths.ts as its twin and drive both from one shared escape-vector list. insideRepo\n'
    + 'handles symlink escape and explains why naive resolve+startsWith is insufficient — match it.' },

  { id: 'T6.3', n: 3, slug: 't6-3-the-install-graph-and-rebuild-graph-commands', role: 'js-dev', planTask: 3, foundation: false, note:
    'THIN means thin: create a terminal, send, show. No output capture, no exit handler, no state,\n'
    + 'no post-run verification. doctor is the only thing that knows how to judge the result.\n'
    + 'extension.ts is at src/extension.ts, NOT src/host/extension.ts.\n'
    + 'With the bundle absent, Rebuild Graph must name Install Graph rather than spawning node on a\n'
    + 'missing path — an ENOENT in a terminal is the failure T6.1 exists to prevent, reappearing at\n'
    + 'the last step.' },

  { id: 'T6.4', n: 4, slug: 't6-4-primer-mjs-injects-map-md-with-a-pointer-in-b', role: 'js-dev', planTask: 4, foundation: false, note:
    'Criterion 3\'s "otherwise" covers BOTH non-injecting branches: over-cap AND absent. An earlier\n'
    + 'draft of the plan narrowed it to "absent means emit nothing", silently changing approved\n'
    + 'behaviour — that draft was wrong and the criterion stands. Absent is the case a workspace that\n'
    + 'has not run octograph yet actually hits, so it is the one that most needs the pointer.\n'
    + 'NEVER truncate the map: a truncated architecture map reads as complete, which is worse than\n'
    + 'none.\n'
    + 'BUMP OCTOBOTS_PACK_VERSION and primer.mjs\'s own version marker. packStatus keys staleness off\n'
    + 'exactly that marker; skip it and installed workspaces never learn the primer changed.' },

  { id: 'T6.5', n: 5, slug: 't6-5-end-to-end-no-graph-a-stale-graph-and-a-launc', role: 'qa-engineer', planTask: 5, foundation: false, note:
    'Assert against observable behaviour, not source reading. The thin-launcher property is the one\n'
    + 'most likely to erode later, so it needs a test that fails when someone adds output capture —\n'
    + 'not a review comment.\n'
    + 'Use the exported artifactPath rather than re-deriving the .octobots/graph vs .octograph\n'
    + 'fallback; a third spelling of that rule is exactly what this tool exists to detect.' },
]

const RULES = `
NON-NEGOTIABLE (violating any of these fails the task):
- Work in ${REPO}. ONE working tree, branches only. NEVER 'git worktree add'.
- SCOPED STAGING: 'git add <exact paths>'. NEVER 'git add -A' — .octobots/ and .claude/ are
  gitignored and the tree may hold another agent's edits.
- ESM + NodeNext: every relative import carries a .js extension. strict +
  noUncheckedIndexedAccess; never a non-null assertion (!) to silence them.
- The extension gains NO runtime dependency on @octoshell/graph. It ships the built bundle as a
  static asset and spawns bare node on it. A devDependency for build ordering is permitted but must
  be stated in the PR, never slipped in.
- THIN LAUNCHER: no output capture, no exit handlers, no state tracking, no post-run verification.
- Bare node — no npx, no network, no install at run time.
- A path is never interpolated into a command string. Resolve it, assert containment, reject shell
  metacharacters, pass it as its own argv element.
- Reuse the single spelling of a rule wherever the import is available. Where it is NOT — the
  extension cannot import packages/graph, by criterion 4 — a duplicated rule must be made VISIBLE:
  cross-referenced to its twin and driven from one shared list of cases, never silently re-derived.
- The extension is TS + esbuild (host) and vite (webview); never hardcode colours, use the
  CSS-variable VS Code theme tokens. This mission adds no webview.
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
    `Build task ${task.id} of Octobots mission M6 (the extension bridge) in ${REPO}.

WHAT M6 IS. octograph is a git-history co-change architecture graph in packages/graph. M1-M5 and M7
shipped map, impact, drift, doctor, own, conflicts, setup, working sets and a self-contained esbuild
bundle (~196 KB) that runs under bare node with no node_modules. M6 is the LAST mission: wire it
into the VS Code extension as a THIN LAUNCHER — two commands that open a terminal on the bundled
CLI, plus primer.mjs injecting map.md as session context.

You are working in apps/vscode-extension, not packages/graph. The extension is TypeScript + esbuild
for the host and vite for the webview; this mission adds no webview.

THE GAP THIS MISSION CLOSES FIRST: nothing currently installs the octograph bundle into a workspace.
resources/octobots-pack/ ships hooks, skill and tokenomics and no graph, and bundle.mjs writes only
to packages/graph/dist. Install Graph as originally specified would spawn node on a path that does
not exist. T6.1 fixes that and everything else depends on it.

SPEC: ${PLAN} — read the whole header (Global Constraints, "The gap this mission has to close
first", and "Task 1's build wiring, designed rather than assumed") and then the section
"### Task ${task.planTask}:".
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
     pnpm --filter @octoshell/vscode-extension test / typecheck / lint
   plus a whole-repo 'pnpm build' — this mission touches the extension and the shipped pack, so a
   package-local green is not sufficient evidence.
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
    `Review task ${task.id} of Octobots mission M6 in ${REPO}.
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
   it scanned a file that by construction could never contain what it searched for. M5's gate then
   found five MORE in the same shape, including guards reading a copy of setup.ts with the install
   flow deleted, and guards scanning src/ one directory deep. Every one was green and enforced
   nothing. For every guard in this diff, ask what edit it would actually catch — and prefer proving
   it: plant a violation, watch the guard fail by name, remove it. A guard nobody has seen fail is
   a guess. This applies hardest to T6.1's freshness check and T6.5's thin-launcher assertion.
3. CLAIMS. This campaign's one recurring defect is a claim that outran what the code computed, and
   it has shipped seven times — a clusterIds field hardcoded to a constant; a count meaning
   something narrower than it said; an edge naming a module with no heading; a --since window
   missing from provenance; a working set spanning modules on zero commits; 'own' silently dropping
   9 of 17 provenance records; '(no conflicts found)' meaning both "clean" and "I had nothing to
   say"; and a doc comment claiming an in-process consumer that never existed, which propagated to
   three files and produced a phantom bug report.
   M6's versions are: an installed-state check that reports "current" without comparing anything;
   a freshness check placed where CI never runs it; and a command that reports success while the
   terminal it opened failed. Audit each against what is actually observed.
4. A DUPLICATED RULE IS BLOCKING — unless it is UNAVOIDABLE and VISIBLE. The extension cannot import
   packages/graph (criterion 4), so T6.2's containment check is a genuine second spelling of
   insideRepo. That is accepted, but only if it is cross-referenced to its twin and driven from one
   shared list of escape vectors. A silent re-derivation, or a weaker check than paths.ts performs,
   is blocking. Anything else re-spelled has no such excuse.
5. THINNESS. No output capture, no exit handler, no state write, no post-run verification. This is
   the property most likely to erode later; check it is enforced by a test rather than by intent.
6. The acceptance criteria: for each, find the code that satisfies it and challenge it.

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
    `You own the merge gate for task ${task.id} of Octobots mission M6 in ${REPO}.
Branch ${branch}, base ${HEAD}, PR ${build.pr_url || `(gh pr list --head ${branch})`}.

READ THE CRITERIA FRESH from ${board}. A criterion that contradicts an approved design decision is a
board defect and blocking on one is correct — that happened on T3.1, whose criterion still demanded
"test files never appear as module members" after the owner had reversed that policy. Judge against
what the file says NOW. This has bitten twice: T3.1's criterion still demanded a policy the owner
had reversed, and M5's criterion 4 was unsatisfiable from the moment it was authored. Note that M6
gained a FIFTH criterion on 2026-08-11 (the bundle must actually reach the workspace) and was
re-estimated to 2 days / M, because the mission had been scoped assuming a payload mechanism that
does not exist.

VERIFY INDEPENDENTLY — take neither the developer's nor the reviewer's word:
1. git checkout ${branch} && git pull --ff-only
2. Run and capture: pnpm --filter @octoshell/vscode-extension test / typecheck / lint, and a
   whole-repo 'pnpm build'. This mission touches the extension and the shipped pack, so a
   package-local green is not enough. Every pre-existing test must still pass.
3. For EACH acceptance criterion, decide pass/fail with concrete evidence — a named test, an
   observed value. A criterion with no evidence is a FAIL. A passing suite is evidence about the
   suite, not about a criterion.
4. Where a criterion says a check FAILS on bad input, make it fail. Corrupt the payload, plant a
   violating call, open no workspace — then observe. A criterion satisfied by reading the code that
   would presumably catch it is not verified.
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
