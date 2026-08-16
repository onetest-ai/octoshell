export const meta = {
  name: 'testing',
  description: "Run a mission's authored cases, judge every screen against its design, analyse, hand off",
  phases: [
    { title: 'Plan',    steps: [{ id: 'p1', agent: 'test-run-lead', label: 'Assemble and plan the run' }] },
    { title: 'Execute', steps: [{ id: 'e1', agent: 'test-runner',   label: 'Run the cases against the app', dependsOn: ['p1'] }] },
    { title: 'Design',  steps: [{ id: 'd1', agent: 'qa-engineer',   label: 'Look and feel vs the authored render', dependsOn: ['e1'] }] },
    { title: 'Report',  steps: [{ id: 'rp', agent: 'test-reporter', label: 'Write the run report with evidence', dependsOn: ['d1'] }] },
    { title: 'Analyse', steps: [{ id: 'an', agent: 'tech-lead',     label: 'Fix, complete, or blocked', dependsOn: ['rp'] }] },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args || '{}') : (args || {})
const { mission, missionName, missionDir, campaignDir, criteria = [], screens = [],
        designSpec, designRender, executor = 'qa-engineer', gateCommand, after,
        uncoveredCriteria = [] } = A
if (!mission) return { blocked: 'no-args', hint: 'pass args from .agents/mission-input.mjs <M>' }

const SIM = 'UDID=$(node .agents/sim.mjs --quiet)'
/* Two hard constraints on simulator use, both learned the expensive way:
     ONE simulator, ever. Never a bare -destination name (it clones a fresh device
     every run) and never a second boot alongside the first.
     NO dead bodies. `xcodebuild test` spawns "Clone N of <device>" simulators for
     parallel testing; a killed or timed-out run leaks them, and overnight they
     accumulate into a dozen orphans holding disk and boot slots. Pass
     -parallel-testing-enabled NO so they are never created, and run the cleanup
     when the run is done. */
const SIM_RULES = [
  'ONE simulator only. Ready it with:  ' + SIM,
  'Pin every xcodebuild/AXe call to that UDID. A bare -destination name clones a fresh',
  'device every run. Never boot a second device alongside it.',
  '',
  'Pass -parallel-testing-enabled NO on every `xcodebuild test`. Without it xcodebuild',
  'spawns "Clone N of <device>" simulators, and a killed run leaves them behind.',
  '',
  'When you are finished testing, leave nothing running:',
  '  node .agents/sim.mjs --cleanup',
].join('\n')
const PLAN = { type: 'object', required: ['cases'], properties: {
  cases: { type: 'array', items: { type: 'object', required: ['id'], properties: {
    id: { type: 'string' }, file: { type: 'string' }, why: { type: 'string' } } } },
  skipped: { type: 'array', items: { type: 'string' } } } }
const RESULT = { type: 'object', required: ['passed', 'failed', 'results'], properties: {
  passed: { type: 'number' }, failed: { type: 'number' }, blocked: { type: 'number' },
  results: { type: 'array', items: { type: 'object', required: ['case', 'status'], properties: {
    case: { type: 'string' }, status: { type: 'string' }, evidence: { type: 'string' }, observed: { type: 'string' } } } } } }
const DESIGN = { type: 'object', required: ['differences'], properties: {
  matches: { type: 'boolean' },
  differences: { type: 'array', items: { type: 'object', required: ['what', 'blocking'], properties: {
    what: { type: 'string' }, spec: { type: 'string' }, build: { type: 'string' }, blocking: { type: 'boolean' } } } } } }
const ANALYSIS = { type: 'object', required: ['verdict'], properties: {
  verdict: { type: 'string' },
  findings: { type: 'array', items: { type: 'object', properties: { what: { type: 'string' }, kind: { type: 'string' }, owner: { type: 'string' } } } } } }

const TRACE = { mission, loop: 'testing', after: after || null, steps: [], design: null, outcome: null }

/* Never let report-writing be the thing that fails a completed run. */
const safe = (v) => {
  try { return JSON.stringify(v, null, 1) }
  catch (e) { return '(report data could not be serialized: ' + e.message + ')' }
}
const finish = async (outcome) => {
  /* A COPY with any back-reference stripped: an outcome carrying the trace made
     TRACE.outcome.run === TRACE, a cycle JSON.stringify throws on. That killed a
     44-agent implementation run at its last step. */
  const { run: _dropped, ...clean } = outcome || {}
  TRACE.outcome = clean
  await agent([
    'Persist this workflow run report. Two files, no other changes:',
    '',
    '1. ' + missionDir + '/workflows/testing/runs/RUN-<today, from date +%F>.md — readable Markdown,',
    '   outcome first, then a section per step. Quote every finding verbatim; never reduce one to a count.',
    '2. Append one compact JSON line to ' + missionDir + '/workflows/testing/runs.jsonl.',
    '',
    'Report the two paths. Do not re-verify anything; do not touch code or the board.',
    '',
    safe(TRACE),
  ].join('\n'), { phase: 'Analyse', label: 'write the run report', agentType: 'run-reporter' })
  return outcome
}

/* Author before running, not after. Coverage is a property of the files on disk, so
   the resolver computes it up front; M8 discovered six uncovered criteria only after
   executing its suite, and filed a bug instead of closing the gap. A criterion no case
   cites is untested no matter how green the run looks. */
if (uncoveredCriteria.length) {
  phase('Plan')
  log(mission + ': ' + uncoveredCriteria.length + ' criteria have no authored case — authoring first')
  await agent([
    'These acceptance criteria of ' + mission + ' have ZERO authored coverage — no case in tests/',
    'cites them:',
    '',
    JSON.stringify(uncoveredCriteria),
    '',
    'Their full text is in ' + missionDir + '/mission.yaml. Write the missing cases.',
    '',
    'Author against the REQUIREMENTS and the user-flow maps, plus ' + (designSpec || 'the design spec') + ' and',
    'the rendered ' + (designRender || 'design page') + ' — never reverse-engineered from the implementation.',
    '',
    'Follow the existing format exactly: tests/<suite>/TC-NNN_<slug>.md, next free number in that',
    'suite. Every step needs an observable expectation and every case an Expected Final State a',
    'snapshot can confirm. CITE the AC id in the case — that citation is how coverage is traced,',
    'and a case that exercises a criterion without naming it still reads as uncovered.',
    '',
    'Where a case needs a true first-launch store, say so in Preconditions: the app exposes',
    '-uiTestFreshInstall, and other cases run before yours and leave data behind.',
  ].join('\n'), { phase: 'Plan', label: 'author ' + uncoveredCriteria.length + ' missing case(s)', agentType: 'test-author' })
  TRACE.steps.push({ step: 'author', criteria: uncoveredCriteria })
}

phase('Plan')
const plan = await agent([
  'Plan the test run for ' + mission + (after ? ' (foundation re-check after ' + after + ')' : '') + '.',
  '',
  'The mission and its criteria:',
  JSON.stringify(criteria, null, 1),
  '',
  'Select the authored cases under tests/ that exercise THIS mission. Do not author new ones unless',
  'a criterion has no case at all — if so, say which, and have test-author write it.',
  '',
  'Then get the app runnable: build, install and launch it.',
  SIM_RULES,
  'It brings up the VISIBLE Simulator.app window so a human can watch, and',
  'Simulator.app window so a human can watch, proves the device renders, and prints the UDID. Pin',
  'every xcodebuild/AXe call to it — a bare device name clones a fresh simulator every run. If it',
  'exits non-zero two simulators are booted; fix that rather than picking one.',
  '',
  'Before scheduling anything, confirm the app can actually be driven:',
  screens.length ? '  node .agents/compare-view.mjs ' + screens[0].id + ' $UDID' : '  (no screens on this mission)',
  'If the specced identifiers are absent that is ONE build defect — say so and stop, rather than',
  'producing a wall of failures that all share a cause.',
].join('\n'), { phase: 'Plan', label: 'plan the run', agentType: 'test-run-lead', schema: PLAN })

TRACE.steps.push({ step: 'plan', cases: plan ? plan.cases.length : 0, skipped: plan ? plan.skipped : null })
if (!plan || !plan.cases.length) return await finish({ blocked: 'nothing-to-run', mission, plan })

phase('Execute')
const run = await agent([
  'Execute these cases for ' + mission + ', one at a time, against the running app:',
  '',
  JSON.stringify(plan.cases, null, 1),
  '',
  'Ready the simulator: ' + SIM + ', and pin every call to that UDID.',
  'Drive the app with XcodeBuildMCP ui-automation: snapshot_ui to see targets, then tap / type_text /',
  'swipe. Refs are snapshot-specific — re-snapshot after any navigation, scroll or sheet change.',
  '',
  'Evidence before PASS: a snapshot confirming the case Expected Final State. A PASS without one is',
  'not a PASS. Reset demo data between cases that need a clean state, so one case writes do not leak',
  'into the next and produce a failure that has nothing to do with the behaviour.',
].join('\n'), { phase: 'Execute', label: 'execute the run', agentType: executor, schema: RESULT })
TRACE.steps.push({ step: 'execute', passed: run && run.passed, failed: run && run.failed, blocked: run && run.blocked })

/* Look and feel is a first-class result, not a side effect of the functional cases. A
   case can pass on behaviour while the screen looks nothing like its spec: right
   control, wrong hierarchy, wrong tokens, regions in the wrong order. compare-view
   diffs STRUCTURE and CONTENT rather than pixels, so it survives legitimate rendering
   differences and still catches a screen built from the criteria instead of the design.
   Sequential: each check drives the one shared simulator. */
phase('Design')
const design = []
for (const s of screens) {
  const d = await agent([
    'Judge screen ' + s.id + (s.title ? ' (' + s.title + ')' : '') + ' of ' + mission + ' against its authored design.',
    '',
    SIM_RULES,
    'Structural diff:      node .agents/compare-view.mjs ' + s.id + ' $UDID',
    '',
    'Then look at all three, side by side:',
    '  the running screen  — XcodeBuildMCP snapshot_ui plus a screenshot',
    '  the authored render — ' + designRender + ', opened in the browser; find ' + s.id + ' on the page',
    '  the spec            — ' + designSpec + ', the ' + s.id + ' entry',
    '',
    'AUTHORITY, when sources disagree — highest first:',
    '  1. Apple Human Interface Guidelines. The design is drawn in HTML on a web canvas; where it',
    '     asks for something that fights the platform (a control iOS renders differently, a gesture',
    '     iOS reserves, type or tap targets below iOS minimums), the PLATFORM WINS. Native feel',
    '     beats pixel fidelity to a mock.',
    '  2. The rendered page. It shows what the screen must LOOK like.',
    '  3. The JSON spec. It says what must be PRESENT — regions, states, tokens, a11yIds.',
    '',
    'So: a build satisfying the JSON that does not look like the render has NOT passed. And a',
    'render detail that would make the app feel un-native is not a defect in the build — it is a',
    'defect in the design. Either way, file the disagreement as its own finding so the record gets',
    'corrected rather than silently diverging from what ships.',
    '',
    'Judge in this order:',
    '  1. Regions present AND in the spec order. A correct element below the fold is still a defect —',
    '     a message the guest must scroll to find is not doing its job.',
    '  2. Every state the spec demands (empty, loading, error, zero-results) actually reachable.',
    '  3. Design-system tokens from docs/design/design-system.json, not hardcoded near-matches.',
    '  4. The a11yIds the spec names (DEC-032). They are the test selectors.',
    '',
    'Per difference: what the spec says, what the build does, whether it blocks.',
    '',
    'BLOCKING is not a judgement call for these — mark them blocking:',
    '  - an element the spec NAMES is absent (a logo, a region, a state, an identifier). "The spec',
    '    names a logo and the build renders none" is blocking, not a nit.',
    '  - the wrong component or hierarchy where the spec is explicit',
    '  - a specced state that cannot be reached',
    '  - geometry that changes what the screen IS: an inset element the design draws full-bleed,',
    '    or the reverse. compare-view checks identifiers and copy, NOT layout — you are the only',
    '    thing looking at geometry, so look at it.',
    'Only genuine cosmetic drift a guest would never notice is a nit.',
    '',
    'And set matches:false if the screen does not match, even when you class each individual',
    'difference as small. That verdict is gated on directly.',
    '',
    'Be specific — "the availability badge sits below the price instead of beside it" beats',
    '"layout differs".',
  ].join('\n'), { phase: 'Design', label: 'design ' + s.id, agentType: 'qa-engineer', schema: DESIGN })
  if (d) design.push({ screen: s.id, verdict: d })
}
TRACE.design = design
/* Gate on the JUDGE'S OWN VERDICT, not only on per-difference flags.
   This filtered on `blocking` alone and ignored `matches`, so a screen the judge had
   explicitly marked matches:false sailed through as green. That is not hypothetical:
   M8's S-009-0 came back matches:false in BOTH runs, the first listed difference being
   "Hero region renders no logo at all — the spec names logo: konpeki_wordmark_on_dark.svg",
   classified blocking:false. The finding was correct, reported, and discarded here; a
   human spotted the same missing brand mark by eye afterwards. */
const designBlocking = design.flatMap((x) => {
  const diffs = x.verdict.differences || []
  const flagged = diffs.filter((y) => y.blocking)
  if (flagged.length) return flagged.map((y) => ({ screen: x.screen, ...y }))
  // matches:false with nothing marked blocking means the judge saw a mismatch and
  // under-classified its parts. Trust the verdict; carry the differences it listed.
  if (x.verdict.matches === false) {
    return diffs.map((y) => ({ screen: x.screen, ...y, blocking: true, escalated: 'screen judged matches:false' }))
  }
  return []
})
if (designBlocking.length) log(mission + ': ' + designBlocking.length + ' blocking design difference(s)')

phase('Report')
const report = await agent([
  'Write the manual-QA run report for ' + mission + ' from these results and design findings.',
  '',
  'Results: ' + JSON.stringify(run),
  'Design:  ' + JSON.stringify(designBlocking),
  '',
  'Save to reports/RUN-<today, from date +%F>-<nnn>.md, linking any screenshots. Quote observed',
  'behaviour verbatim.',
].join('\n'), { phase: 'Report', label: 'write the run report', agentType: 'test-reporter' })

phase('Analyse')
const analysis = await agent([
  'Analyse this run for ' + mission + ' and decide what happens next.',
  '',
  'Results: ' + JSON.stringify(run),
  'Report: ' + String(report).slice(0, 4000),
  '',
  'Design conformance — blocking differences vs the authored specs:',
  JSON.stringify(designBlocking),
  '',
  'Treat a blocking design difference as a real defect, not a cosmetic note. These screens were',
  'designed before they were built; one that passes its cases while looking nothing like its spec',
  'has not delivered the mission. File them as bugs the same as functional failures.',
  '',
  'For each failure decide which it is, because they lead different places:',
  '  - a defect in the app        -> file a bug on the mission that OWNS the behaviour, not on',
  '                                  ' + mission + ' by reflex',
  '  - a defect in the test case  -> the case is wrong or stale; a finding for test-author',
  '  - a blocked case             -> a missing identifier or unreachable precondition; a build or',
  '                                  seed defect, not evidence about the behaviour',
  '',
  'Return a verdict: complete ONLY if the cases are green AND no blocking design difference remains;',
  'fix if there is work to do; blocked if the run could not establish anything.',
  '',
  'File the bugs you decided on with add-bug.js before returning.',
].join('\n'), { phase: 'Analyse', label: 'analyse the results', agentType: 'tech-lead', schema: ANALYSIS })

if (!analysis || analysis.verdict === 'blocked') return await finish({ blocked: 'analysis', mission, analysis })
if (analysis.verdict === 'fix' || designBlocking.length) {
  return await finish({ needsFixing: true, mission, findings: analysis.findings, designBlocking,
    next: 'fixing', nextCommand: 'node .agents/mission-input.mjs ' + mission + '  ->  .octobots/campaigns/hotelbooking-mvp-konpeki-plaza-booking-funnel/workflows/fixing/workflow.js' })
}

return await finish({
  mission, green: true, next: 'gate', readyToGate: true, gateCommand,
  note: 'Cases green and no blocking design difference. Run gateCommand from the MAIN session — the PostToolUse hook fires there and mission-completion-gate can dispatch. Then merge.',
})
