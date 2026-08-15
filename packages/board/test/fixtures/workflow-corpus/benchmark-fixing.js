export const meta = {
  name: 'fixing',
  description: "Work a mission's open bugs to green: triage, fix with a regression test, re-verify, close",
  phases: [
    { title: 'Triage',   steps: [{ id: 't1', agent: 'tech-lead', label: 'Triage the open bugs' }] },
    { title: 'Fix',      steps: [{ id: 'f1', agent: 'ios-dev',   label: 'Fix each with its regression test', dependsOn: ['t1'] }] },
    { title: 'Reverify', steps: [{ id: 'v1', agent: 'test-runner', label: 'Re-run the cases that caught them', dependsOn: ['f1'] }] },
    { title: 'Close',    steps: [{ id: 'c1', agent: 'project-manager', label: 'Close the bugs', dependsOn: ['v1'] }] },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args || '{}') : (args || {})
const { mission, missionDir, screens = [], designSpec, designRender, executor = 'qa-engineer', gateCommand } = A
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
const BUGS = { type: 'object', required: ['bugs'], properties: {
  bugs: { type: 'array', items: { type: 'object', required: ['slug', 'what'], properties: {
    slug: { type: 'string' }, what: { type: 'string' }, cases: { type: 'array', items: { type: 'string' } },
    screen: { type: 'string' }, kind: { type: 'string' } } } } } }
const FIX = { type: 'object', required: ['fixed'], properties: {
  fixed: { type: 'boolean' }, summary: { type: 'string' }, regressionTest: { type: 'string' } } }
const VERIFY = { type: 'object', required: ['allGreen', 'results'], properties: {
  allGreen: { type: 'boolean' },
  results: { type: 'array', items: { type: 'object', properties: { slug: { type: 'string' }, green: { type: 'boolean' }, observed: { type: 'string' } } } } } }

const TRACE = { mission, loop: 'fixing', steps: [], outcome: null }

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
    '1. ' + missionDir + '/workflows/fixing/runs/RUN-<today, from date +%F>.md — readable Markdown,',
    '   outcome first, then one section per bug: what it was, the fix, the regression test, and the',
    '   re-verify result. Quote every finding verbatim; never reduce one to a count.',
    '2. Append one compact JSON line to ' + missionDir + '/workflows/fixing/runs.jsonl.',
    '',
    'Report the two paths. Do not re-verify anything; do not touch code or the board.',
    '',
    safe(TRACE),
  ].join('\n'), { phase: 'Close', label: 'write the run report', agentType: 'run-reporter' })
  return outcome
}

phase('Triage')
const triage = await agent([
  'Triage the open bugs on ' + mission + '.',
  '',
  'Read them from the board: ' + missionDir + '/bugs/',
  'For each, say what is actually wrong, which authored case caught it (if any), and — for a',
  'look-and-feel bug — which screen and what the design says it should be.',
  '',
  'Order them so shared causes are fixed once: if three bugs share a root cause, say so.',
].join('\n'), { phase: 'Triage', label: 'triage open bugs', agentType: 'tech-lead', schema: BUGS })

TRACE.steps.push({ step: 'triage', bugs: triage ? triage.bugs.length : 0 })
if (!triage || !triage.bugs.length) {
  log('no open bugs')
  return await finish({ fixed: [], reason: 'no open bugs', next: 'testing' })
}

phase('Fix')
const fixed = []
for (const bug of triage.bugs) {
  const fix = await agent([
    'Fix this bug on ' + mission + ', and add the regression test that would have caught it:',
    '',
    JSON.stringify(bug, null, 1),
    '',
    bug.screen && designRender
      ? 'This is a look-and-feel defect. The design is authoritative — look at ' + designRender +
        ' (open it in the browser, find ' + bug.screen + ') and the ' + bug.screen + ' entry in ' +
        designSpec + ' before changing anything. Use the tokens in docs/design/design-system.json,' +
        ' keep the spec region ORDER, and keep every a11yId the spec names — tests select on them.'
      : 'Fix the behaviour, not the symptom the case happened to observe.',
    '',
    'Leave the suite green (' + SIM + '). Commit on the current branch.',
  ].join('\n'), { phase: 'Fix', label: 'fix ' + bug.slug, agentType: 'ios-dev', schema: FIX })
  if (!fix || !fix.fixed) return await finish({ blocked: 'unfixable', bug: bug.slug, fixed, detail: fix })
  fixed.push({ slug: bug.slug, summary: fix.summary, regressionTest: fix.regressionTest })
}

phase('Reverify')
let verify = await agent([
  'Re-run the cases these bugs came from, against the rebuilt app:',
  '',
  JSON.stringify(triage.bugs.map((b) => ({ slug: b.slug, cases: b.cases, screen: b.screen })), null, 1),
  '',
  'Only those cases — a fix is proven by the case that caught it, and the full suite re-runs at the',
  'gate anyway. For a look-and-feel bug, re-check the screen against ' + designRender + ' as well:',
  'node .agents/compare-view.mjs <screen-id> $UDID, then look at both.',
  '',
  'Evidence before PASS. A fix that does not turn its own case green is not a fix.',
  '',
  SIM_RULES,
  'It brings up the VISIBLE Simulator.app window so a human can watch, and',
  'Simulator.app window so a human can watch, proves the device renders, and prints the UDID to pin',
  'every call to. A bare device name clones a fresh simulator.',
].join('\n'), { phase: 'Reverify', label: 're-run the failing cases', agentType: executor, schema: VERIFY })

for (let round = 0; round < 2 && verify && !verify.allGreen; round++) {
  const red = verify.results.filter((r) => !r.green)
  log(mission + ': ' + red.length + ' still red, re-fix round ' + (round + 1) + ' of 2')
  for (const r of red) {
    await agent([
      'This fix did not hold. Re-fix it properly:', '', JSON.stringify(r, null, 1), '',
      'Leave the suite green (' + SIM + ').',
    ].join('\n'), { phase: 'Reverify', label: 're-fix ' + r.slug, agentType: 'ios-dev', schema: FIX })
  }
  verify = await agent('Re-run the cases for the bugs that were still red; report per bug.',
    { phase: 'Reverify', label: 're-verify', agentType: executor, schema: VERIFY })
}
TRACE.steps.push({ step: 'reverify', allGreen: verify ? verify.allGreen : false })
if (!verify || !verify.allGreen) return await finish({ blocked: 'still-red', fixed, verify })

phase('Close')
const closed = await agent([
  'Every bug on ' + mission + ' is fixed and its case is green. Close them:',
  '',
  '  node .claude/skills/mission-planner/scripts/set-status.js ' + missionDir + ' "<bug title>" done',
  '',
  'One call per bug. Report what closed and what regression tests were added.',
  '',
  'Do NOT flip the mission done here — that is the gate trigger, it must run from the main session,',
  'and the gate has to re-verify independently rather than trust this loop own result.',
].join('\n'), { phase: 'Close', label: 'close the bugs', agentType: 'project-manager', model: 'haiku' })

return await finish({
  closed, fixed, mission, next: 'testing',
  nextCommand: 'node .agents/mission-input.mjs ' + mission + '  ->  .octobots/campaigns/hotelbooking-mvp-konpeki-plaza-booking-funnel/workflows/testing/workflow.js',
  gateCommand,
  note: 'Bugs fixed and closed. Re-run TESTING to confirm green, then run gateCommand from the main session to fire the completion gate, then merge.',
})
