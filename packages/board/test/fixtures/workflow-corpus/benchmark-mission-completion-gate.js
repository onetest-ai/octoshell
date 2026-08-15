export const meta = {
  name: 'mission-completion-gate',
  description: 'Blocking mission gate: tests+coverage, black-box QA, design conformance, critical review',
  phases: [
    { title: 'Tests+Coverage', steps: [{ id: 't1', agent: 'ios-dev', label: 'Suites + new-code coverage' }] },
    { title: 'QA', steps: [{ id: 'q1', agent: 'qa-engineer', label: 'Black-box vs acceptance criteria', dependsOn: ['t1'] }] },
    { title: 'Design', steps: [{ id: 'd1', agent: 'qa-engineer', label: 'Look and feel vs the authored render', dependsOn: ['q1'] }] },
    { title: 'Review', steps: [{ id: 'r1', agent: 'tech-lead', label: 'Whole-branch diff, security lens', dependsOn: ['d1'] }] },
    { title: 'Tokenomics', steps: [{ id: 'k1', agent: 'project-manager', label: 'Capture mission cost', dependsOn: ['r1'] }] },
    { title: 'Complete', steps: [{ id: 'c1', agent: 'run-reporter', label: 'Write the gate report', dependsOn: ['k1'] }] },
  ],
}

/* args arrives as a JSON STRING. Destructuring the raw global silently yields
   undefined for every field and base falls through to 'main' unnoticed. */
const A = typeof args === 'string' ? JSON.parse(args || '{}') : (args || {})
const { mission, criteria = [], base = 'main', screens = [], hyp = '', missionDir } = A
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

const TESTS = { type: 'object', required: ['green', 'failures'], properties: {
  green: { type: 'boolean' }, coveragePct: { type: 'number' }, coverageMeasurable: { type: 'boolean' },
  suitesRun: { type: 'number' }, failures: { type: 'array', items: { type: 'string' } }, detail: { type: 'string' } } }
const QA = { type: 'object', required: ['criteria'], properties: {
  criteria: { type: 'array', items: { type: 'object', required: ['id', 'pass', 'evidence'], properties: {
    id: { type: 'string' }, pass: { type: 'boolean' }, evidence: { type: 'string' }, question: { type: 'string' } } } },
  questionsForBA: { type: 'array', items: { type: 'string' } } } }
const DESIGN = { type: 'object', required: ['screens'], properties: {
  screens: { type: 'array', items: { type: 'object', required: ['id', 'matches'], properties: {
    id: { type: 'string' }, matches: { type: 'boolean' },
    blocking: { type: 'array', items: { type: 'string' } }, nits: { type: 'array', items: { type: 'string' } } } } } } }
const REVIEW = { type: 'object', required: ['fixed', 'stillOpen', 'nits'], properties: {
  fixed: { type: 'array', items: { type: 'object', properties: {
    what: { type: 'string' }, criterion: { type: 'string' }, regressionTest: { type: 'string' } } } },
  stillOpen: { type: 'array', items: { type: 'object', properties: {
    what: { type: 'string' }, why: { type: 'string' }, criterion: { type: 'string' } } } },
  nits: { type: 'array', items: { type: 'string' } },
  processFindings: { type: 'array', items: { type: 'string' } } } }
const TOK = { type: 'object', properties: { ran: { type: 'boolean' }, summary: { type: 'string' } } }

const GATE = { mission, base, phases: {} }

const report = async (verdict) => {
  GATE.verdict = verdict
  await agent([
    'Persist this mission-gate report. Two files, no other changes:',
    '',
    '1. reports/GATE-' + mission.split(' ')[0] + '-<today, from date +%F>.md - readable Markdown.',
    '   Verdict first, then a section per phase: suites and coverage, the per-criterion black-box',
    '   verdict as a table, design conformance per screen, and the review findings split fixed vs',
    '   still-open. Quote every finding verbatim; never reduce one to a count.',
    '2. Append one compact JSON line to reports/gates.jsonl.',
    '',
    'Report the two paths. Do not re-verify anything; do not touch code or the board.',
    '',
    JSON.stringify(GATE, null, 1),
  ].join('\n'), { phase: 'Complete', label: 'write the gate report', agentType: 'run-reporter' })
  return verdict
}

phase('Tests+Coverage')
const tests = await agent([
  'Run the mechanical gate for ' + mission + ' on the current branch.',
  '',
  'Ready the simulator first, then pin every call to the UDID it prints:',
  SIM_RULES,
  'A bare device name clones a fresh simulator every run (.agents/testing.md).',
  '',
  'The full suite takes ~5 MINUTES. Run it DETACHED and poll, or your turn ends mid-run and you',
  'report a failure that never happened — that is exactly how this gate blocked once already:',
  '',
  '  LOG=$TMPDIR/gate-suite.log',
  '  cat > $TMPDIR/run.sh <<SH',
  '  cd /Users/arozumenko/Development/benchmark',
  '  xcodebuild -project HotelBooking/HotelBooking.xcodeproj -scheme HotelBooking \\\\',
  '    -destination "platform=iOS Simulator,id=$UDID" \\\\',
  '    -parallel-testing-enabled NO -enableCodeCoverage YES test > $LOG 2>&1',
  '  echo DONE >> $LOG',
  '  SH',
  '  chmod +x $TMPDIR/run.sh && nohup $TMPDIR/run.sh >/dev/null 2>&1 & disown',
  '',
  'Then poll until "DONE" appears in the log — sleep between checks, do not busy-wait. Read the',
  'verdict from the log, never from whether your command returned.',
  '',
  'A run killed before it finishes is NOT a failure. If you cannot get a completed run, say so',
  'plainly and set coverageMeasurable=false rather than reporting green=false, which blocks the',
  'gate on a test suite that may well be passing.',
  '',
  'Then report new-code coverage for lines changed vs ' + base + ' (xcrun xccov on the .xcresult).',
  'If it genuinely cannot be measured, set coverageMeasurable=false and say why. Do NOT invent a',
  'number. If a suite is red, fix it TDD-style and re-run.',
].join('\n'), { phase: 'Tests+Coverage', label: 'suites + coverage', agentType: 'ios-dev', schema: TESTS })
GATE.phases.tests = tests
if (!tests || !tests.green) return await report({ blocked: 'tests' })

phase('QA')
const qa = await agent([
  'You are QA on ' + mission + '. BLACK-BOX: verify against ONLY these acceptance criteria.',
  '',
  'You must NOT read the implementation, the diff, or anything under HotelBooking/HotelBooking/.',
  'You MAY run the app, drive it, and query the SwiftData store.',
  SIM_RULES,
  '',
  JSON.stringify(criteria, null, 1),
  '',
  'For each criterion: pass/fail plus the observable evidence you saw. If one is ambiguous, record',
  'a question rather than guessing an interpretation that happens to pass.',
].join('\n'), { phase: 'QA', label: 'black-box vs criteria', agentType: 'qa-engineer', schema: QA })
GATE.phases.qa = qa
if (!qa || qa.criteria.some((c) => !c.pass)) return await report({ blocked: 'qa' })

phase('Design')
let design = { screens: [] }
if (screens.length) {
  design = await agent([
    'Judge the look and feel of ' + mission + ' against the authored designs. Screens:',
    JSON.stringify(screens),
    '',
    SIM_RULES,
    'Per screen:           node .agents/compare-view.mjs <screen-id> $UDID',
    '',
    'Then open the authored render and compare side by side:',
    '  docs/design/html/' + String(hyp).toLowerCase() + '.html',
    'Open it in the browser (claude-in-chrome) and find each screen on the page.',
    '',    'AUTHORITY, when sources disagree — highest first:',
    '  1. Apple Human Interface Guidelines. The design is drawn in HTML on a web canvas; where it',
    '     asks for something that fights the platform (a control iOS renders differently, a gesture',
    '     iOS reserves, type or tap targets below iOS minimums), the PLATFORM WINS. Native feel',
    '     beats pixel fidelity to a mock.',
    '  2. The rendered page — what the screen must LOOK like.',
    '  3. The JSON spec — what must be PRESENT: regions, states, tokens, a11yIds.',
    '',
    'A build satisfying the JSON that does not look like the render has NOT passed. A render detail',
    'that would make the app feel un-native is a defect in the DESIGN, not the build. Either way',
    'file the disagreement as its own finding, so the record gets corrected rather than quietly',
    'diverging from what ships.',
    '',
    'Judge: regions present AND in spec order (a buried element is a defect even when present);',
    'every demanded state reachable; design-system tokens from docs/design/design-system.json',
    'rather than values that merely look close; the DEC-032 identifiers the spec names.',
    '',
    'An element the spec NAMES but the build omits is blocking — a logo, a region, a state.',
    'So is geometry that changes what the screen IS: inset where the design is full-bleed, or',
    'the reverse. compare-view checks identifiers and copy, NOT layout, so you are the only',
    'thing looking at geometry.',
    '',
    'Set matches:false whenever the screen does not match, even if each difference seems small —',
    'that verdict is gated on directly. Only genuine cosmetic drift is a nit.',
  ].join('\n'), { phase: 'Design', label: 'look and feel', agentType: 'qa-engineer', schema: DESIGN })
  GATE.phases.design = design
  // !matches is sufficient on its own. Requiring a non-empty blocking list as well let a
  // screen the judge marked matches:false pass, which is exactly how M8's missing hero
  // wordmark survived two testing runs and this gate.
  const bad = (design.screens || []).filter((s) => !s.matches)
  if (bad.length) return await report({ blocked: 'design', screens: bad.map((s) => s.id) })
}

phase('Review')
const review = await agent([
  'You are the tech lead. Review the whole-mission diff for ' + mission + ':',
  '  git diff ' + base + '...HEAD',
  '',
  'Apply a security lens, then challenge each implementation decision against the criteria:',
  JSON.stringify(criteria, null, 1),
  '',
  'Fix every blocking finding yourself, add the regression test that would have caught it, and',
  're-run the suite green (ready the simulator with: ' + SIM + ').',
  '',
  'Return findings as fixed vs stillOpen. A finding you fixed and regression-tested is the review',
  'working - put it in fixed, not stillOpen.',
  '',
  'This gate is for INTEGRATION defects: abstractions duplicated across tasks, contracts that do',
  'not compose, end-to-end determinism. If you keep finding PREMISE defects instead, say so in',
  'processFindings - that means task-level review let them through and later tasks built on them.',
].join('\n'), { phase: 'Review', label: 'whole-branch review', agentType: 'tech-lead', schema: REVIEW })
GATE.phases.review = review
if (!review) return await report({ blocked: 'review-agent-died' })
if (review.stillOpen.length) return await report({ blocked: 'review' })

if (review.fixed.length) {
  const affected = criteria.filter((c) => review.fixed.some((f) => f.criterion && String(f.criterion).includes(c.id)))
  if (affected.length) {
    const recheck = await agent([
      'You are QA. You already passed these criteria, then the tech lead changed the code you',
      'verified. Re-verify ONLY these against the FIXED build - still black-box, still no source:',
      '',
      JSON.stringify(affected, null, 1),
      '',
      'For each defect fixed, prove the specific failure it describes can no longer occur.',
      SIM_RULES,
    ].join('\n'), { phase: 'Review', label: 're-verify fixed criteria', agentType: 'qa-engineer', schema: QA })
    GATE.phases.recheck = recheck
    if (!recheck || recheck.criteria.some((c) => !c.pass)) return await report({ blocked: 'qa-recheck' })
  }
}

/* The gate's black-box QA is the strongest evidence any criterion gets — judged against
   the criteria alone, without the diff or the source. Tick from it, so the board's
   checklist finally says what was actually verified rather than staying empty behind a
   `done` status. */
if (missionDir && qa && qa.criteria) {
  const passing = qa.criteria.map((c, i) => ({ n: i + 1, pass: c.pass })).filter((c) => c.pass)
  if (passing.length) {
    await agent([
      'Tick these gate-verified acceptance criteria. One command each, then report what they',
      'printed. Do nothing else.',
      '',
      ...passing.map((c) => '  node .claude/skills/mission-planner/scripts/set-criterion.js ' + missionDir + '/mission.yaml check ' + c.n),
      '',
      'Anything not listed failed or was not verified — leave it unticked.',
    ].join('\n'), { phase: 'Tokenomics', label: 'tick ' + passing.length + ' criteria', agentType: 'project-manager', model: 'haiku' })
  }
}

phase('Tokenomics')
GATE.phases.tokenomics = await agent([
  'Run: node .octobots/tokenomics/run.mjs',
  'Report the row for ' + mission.split(' ')[0] + ' from .octobots/tokenomics/runs.json (cost,',
  'tokens, turns, dispatches, net_loc) and whether authored sizing is present.',
  'Also run: node .octobots/tokenomics/backfill-worklog-sha.mjs - report how many entries it filled,',
  'and note cleanly if it skips because octograph is absent.',
  'Commit the refreshed .octobots/tokenomics/ artifacts.',
  '',
  'NON-BLOCKING: if anything fails, report it and continue. Never fail the gate over analytics.',
].join('\n'), { phase: 'Tokenomics', label: 'capture mission cost', agentType: 'project-manager', schema: TOK })

phase('Complete')
return await report({ blocked: null, green: true })
