export const meta = {
  name: 'implementation',
  description: "Build a mission's tasks in order, review each, verify the mission, hand off to testing",
  phases: [
    { title: 'Build',    steps: [{ id: 'b1', agent: 'ios-dev', label: 'Build each task in order' }] },
    { title: 'Review',   steps: [
        { id: 'r1', agent: 'tech-lead',   label: 'Correctness vs the task criteria', parallel: 'rev', dependsOn: ['b1'] },
        { id: 'r2', agent: 'tech-lead',   label: 'Swift 6 concurrency and SwiftData', parallel: 'rev', dependsOn: ['b1'] },
        { id: 'r3', agent: 'test-author', label: 'Does it satisfy the authored cases', parallel: 'rev', dependsOn: ['b1'] } ] },
    { title: 'Verify',   steps: [{ id: 'v1', agent: 'qa-engineer', label: 'Mission criteria end to end', dependsOn: ['r1','r2','r3'] }] },
    { title: 'Handoff',  steps: [{ id: 'h1', agent: 'run-reporter', label: 'Run report — next: testing', dependsOn: ['v1'] }] },
  ],
}

/* Shared pipeline. Everything mission-specific arrives in `args` from
   `node .agents/mission-input.mjs <M>` — workflow scripts have no filesystem access,
   so discovery cannot happen in here. This one script replaces what used to be eight
   generated copies that differed only in their inputs. */
const A = typeof args === 'string' ? JSON.parse(args || '{}') : (args || {})
const { mission, missionName, missionDir, campaignDir, criteria = [], tasks = [], qaTask,
        screens = [], designSpec, designRender, gateCommand, fromTask, constraints } = A
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
const DESIGN = designRender
  ? ['BUILD TO THE DESIGN, not merely to the criteria. These screens were designed before they were',
     'built and the criteria describe behaviour only — a screen can satisfy every one of them and',
     'still look nothing like what was drawn:',
     '  ' + designSpec + '   what must be present: regions, states, tokens, a11yIds',
     '  ' + designRender + '   what it must LOOK like — open it and look BEFORE you build',
     'Use the tokens in docs/design/design-system.json rather than values that merely look close,',
     'keep the spec region ORDER (a correct element below the fold is still a defect), and give every',
     'element the a11yId the spec names — those are the test selectors. Testing and the gate both',
     're-check this, so a mismatch comes back to you.', ''].join('\n')
  : ''

const IMPL   = { type: 'object', required: ['summary'], properties: { summary: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } }
const REVIEW = { type: 'object', required: ['blocking'], properties: {
  blocking: { type: 'array', items: { type: 'object', required: ['what'], properties: { what: { type: 'string' }, why: { type: 'string' } } } },
  nits: { type: 'array', items: { type: 'string' } } } }
const QA = { type: 'object', required: ['passed'], properties: {
  passed: { type: 'boolean' },
  failures: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, observed: { type: 'string' } } } } } }

const RUN = { mission, fromTask: fromTask || null, tasks: [], verify: null, outcome: null }

/* Never let report-writing be the thing that fails a completed run. */
const safe = (v) => {
  try { return JSON.stringify(v, null, 1) }
  catch (e) { return '(report data could not be serialized: ' + e.message + ')\n' + String(v && v.mission) }
}

const setStatus = (dir, title, state, ph) => agent(
  'Run exactly this one command, then report the line it printed. Do nothing else.\n\n' +
  '  node .claude/skills/mission-planner/scripts/set-status.js ' + dir + ' "' + title + '" ' + state,
  { phase: ph, label: state + ' ' + title.split(' - ')[0], agentType: 'project-manager', model: 'haiku' })

/* Ticking a criterion is NOT the same as flipping a status, and only the first says
   anything was verified. This pipeline flipped statuses and never ticked, so the board
   read "done" while its own checklist said nothing had been checked — M8's testing run
   filed that as a major bug against T8.6, correctly.

   Ticked from the QA verdict, which is the only evidence that establishes a criterion.
   Failed ones are deliberately left unticked. */
const tickCriteria = async (entity, verdicts, ph) => {
  const passing = (verdicts || []).map((c, i) => ({ n: i + 1, pass: c.pass })).filter((c) => c.pass)
  if (!passing.length) return
  await agent([
    'Tick these verified acceptance criteria on the board. Run one command per criterion,',
    'then report the lines they printed. Do nothing else.',
    '',
    ...passing.map((c) => '  node .claude/skills/mission-planner/scripts/set-criterion.js ' + entity + ' check ' + c.n),
    '',
    'Criteria not listed here failed or were not verified — leave them unticked.',
  ].join('\n'), { phase: ph, label: 'tick ' + passing.length + ' criteria', agentType: 'project-manager', model: 'haiku' })
}

const finish = async (outcome) => {
  /* Assign a COPY, and strip any back-reference to RUN. Passing `run: RUN` in an
     outcome made RUN.outcome.run === RUN — a cycle JSON.stringify throws on, which
     killed a 44-agent run at the last step, after every task was built and
     committed. The report is the one thing that must not be able to fail. */
  const { run: _dropped, ...clean } = outcome || {}
  RUN.outcome = clean
  await agent([
    'Persist this workflow run report. Two files, no other changes:',
    '',
    '1. ' + missionDir + '/workflows/implementation/runs/RUN-<today, from date +%F>.md — readable',
    '   Markdown: outcome first, then a row per task (build summary, review rounds, blocking',
    '   findings and whether they were resolved), then the verify result.',
    '   Quote every finding verbatim; never reduce one to a count.',
    '2. Append one compact JSON line to ' + missionDir + '/workflows/implementation/runs.jsonl.',
    '',
    'Report the two paths. Do not re-verify anything; do not touch code or the board.',
    '',
    safe(RUN),
  ].join('\n'), { phase: 'Handoff', label: 'write the run report', agentType: 'run-reporter' })
  return outcome
}

const buildPrompt = (t) => [
  'Build ' + t.id + ' - ' + t.label + ' on mission ' + mission + '.',
  '',
  'Start with: node .agents/brief.mjs ' + t.id,
  'It carries the scope, the criteria you are judged against, the decisions that bind this work and',
  'the identifiers DEC-032 makes mandatory, in ~2k tokens. Do not read the whole record instead.',
  '',
  DESIGN,
  constraints ? 'MISSION CONSTRAINTS — read before you design anything:\n' + constraints + '\n' : '',
  'Stay on the current branch. Leave the build green (pin xcodebuild to the UDID from ' + SIM + ').',
].join('\n')

const reviewPrompt = (t, lens) => [
  'Review what ' + t.id + ' just built on ' + mission + ', through one lens: ' + lens + '.',
  '',
  'The criteria it is judged against:',
  JSON.stringify(t.criteria || [], null, 1),
  '',
  'Report only what BLOCKS — a defect a user or a later task would hit. Everything else is a nit.',
  'Be concrete: what is wrong, and the input or state that makes it wrong.',
].join('\n')

/* A task without `dir` cannot have its criteria ticked — the resolver emits it, but a
   hand-built args payload can drop it. Say so once rather than silently skipping. */
if (tasks.some((t) => !t.dir)) log('note: ' + tasks.filter((t) => !t.dir).length + ' task(s) have no dir — their criteria cannot be ticked')

const startAt = fromTask ? tasks.findIndex((t) => t.id === fromTask) : 0
if (fromTask && startAt < 0) return { blocked: 'unknown-task', fromTask }
if (startAt > 0) log('starting at ' + fromTask + ' — skipping ' + startAt + ' task(s) already built')

await setStatus(campaignDir, missionName, 'active', 'Build')

phase('Build')
for (const t of tasks.slice(startAt)) {
  await setStatus(missionDir, t.id + ' - ' + t.label, 'active', 'Build')
  const rec = { id: t.id, label: t.label, reviewRounds: 0, findings: [] }
  RUN.tasks.push(rec)

  /* Sequential: these write one tree on one branch. */
  const built = await agent(buildPrompt(t), { phase: 'Build', label: 'build ' + t.id, agentType: 'ios-dev', schema: IMPL })
  if (!built) return await finish({ blocked: 'agent-died', task: t.id })
  rec.build = String(built.summary || '').slice(0, 400)

  phase('Review')
  const round = () => parallel([
    () => agent(reviewPrompt(t, 'correctness against the task criteria'), { phase: 'Review', label: 'review ' + t.id + ':correctness', agentType: 'tech-lead', schema: REVIEW }),
    () => agent(reviewPrompt(t, 'Swift 6 strict concurrency and SwiftData usage'), { phase: 'Review', label: 'review ' + t.id + ':concurrency', agentType: 'tech-lead', schema: REVIEW }),
    () => agent(reviewPrompt(t, 'whether this satisfies what the authored test cases assume'), { phase: 'Review', label: 'review ' + t.id + ':cases', agentType: 'test-author', schema: REVIEW }),
  ]).then((rs) => rs.filter(Boolean).flatMap((r) => r.blocking || []))

  let blocking = await round()
  rec.findings.push(...blocking.map((b) => b.what))
  for (let i = 0; i < 2 && blocking.length; i++) {
    log(t.id + ': ' + blocking.length + ' blocking, fix round ' + (i + 1) + ' of 2')
    await agent([
      'Fix these blocking findings on ' + t.id + ', and add the regression test that would have',
      'caught each one:', '', JSON.stringify(blocking, null, 1), '',
      'Leave the suite green (' + SIM + ').',
    ].join('\n'), { phase: 'Review', label: 'fix ' + t.id, agentType: 'ios-dev', schema: IMPL })
    blocking = await round()
    rec.reviewRounds++
    rec.findings.push(...blocking.map((b) => b.what))
  }
  if (blocking.length) return await finish({ blocked: 'review', task: t.id, blocking })
  rec.resolved = true

  /* A build task's criteria are verified by its review going green — that is the only
     evidence this loop produces for them, and nothing was ticking them at all. M2 shipped
     with every task at 0/N ticked while the mission itself read 7/7. */
  if (t.dir) {
    await agent([
      'Tick every acceptance criterion on ' + t.id + ' — its review passed with no blocking',
      'findings. Run one command per criterion, then report what they printed. Nothing else.',
      '',
      '  node .claude/skills/mission-planner/scripts/set-criterion.js ' + t.dir + '/task.yaml check <n>',
      '',
      'The criteria are the acceptance_criteria list in that file, numbered from 1.',
    ].join('\n'), { phase: 'Build', label: 'tick ' + t.id + ' criteria', agentType: 'project-manager', model: 'haiku' })
  }
  await setStatus(missionDir, t.id + ' - ' + t.label, 'done', 'Build')
  phase('Build')
}

phase('Verify')
if (qaTask) await setStatus(missionDir, qaTask.id + ' - ' + qaTask.label, 'active', 'Verify')
const QA_PROMPT = [
  'Verify ' + mission + ' as a whole against its acceptance criteria:',
  '',
  JSON.stringify(criteria, null, 1),
  '',
  'Judge against those and nothing else — not the code, not the task descriptions.',
  '',
  SIM_RULES,
  'It brings up the VISIBLE Simulator.app window so a human can watch, and',
  'Simulator.app window so a human can watch this stage, proves the device renders, and prints the',
  'UDID. Pin every xcodebuild/AXe call to it — a bare device name clones a fresh simulator every',
  'run. If it exits non-zero two simulators are booted; fix that rather than picking one.',
  '',
  'Return pass/fail per criterion with the evidence you observed.',
].join('\n')

let qa = await agent(QA_PROMPT, { phase: 'Verify', label: 'verify ' + mission, agentType: 'qa-engineer', schema: QA })
for (let i = 0; i < 2 && qa && !qa.passed; i++) {
  log(mission + ' verify failed on ' + (qa.failures || []).length + ' criterion/criteria, round ' + (i + 1) + ' of 2')
  await agent([
    'These mission criteria failed verification. Fix them, with the regression test that would have',
    'caught each:', '', JSON.stringify(qa.failures, null, 1), '', 'Leave the suite green (' + SIM + ').',
  ].join('\n'), { phase: 'Verify', label: 'fix ' + mission, agentType: 'ios-dev', schema: IMPL })
  qa = await agent(QA_PROMPT, { phase: 'Verify', label: 're-verify ' + mission, agentType: 'qa-engineer', schema: QA })
}
RUN.verify = qa ? { passed: qa.passed, failures: qa.failures || [] } : null
if (!qa || !qa.passed) return await finish({ blocked: 'qa', mission, qa })

// The mission's own criteria are what QA just judged, so tick those. The QA task's
// criteria describe the same verification from its side and are ticked with it.
await tickCriteria(missionDir + '/mission.yaml', qa.criteria || criteria.map(() => ({ pass: true })), 'Verify')
if (qaTask) {
  if (qaTask.dir) {
    // The QA task has its OWN criteria list, unrelated in length to the mission's — ticking by
    // the mission's verdict indices left T3.5 at 0/4 while the mission read 11/11. Its criteria
    // are verified by the mission verify passing, which is exactly what this task exists to do.
    await agent([
      'Tick every acceptance criterion on ' + qaTask.id + ' — the mission verification it owns',
      'passed. One command per criterion, then report what they printed. Nothing else.',
      '',
      '  node .claude/skills/mission-planner/scripts/set-criterion.js ' + qaTask.dir + '/task.yaml check <n>',
      '',
      'The criteria are the acceptance_criteria list in that file, numbered from 1 — read the file',
      'to see how many there are rather than assuming the mission\'s count.',
    ].join('\n'), { phase: 'Verify', label: 'tick ' + qaTask.id + ' criteria', agentType: 'project-manager', model: 'haiku' })
  }
  await setStatus(missionDir, qaTask.id + ' - ' + qaTask.label, 'done', 'Verify')
}

phase('Handoff')
/* Implementation does NOT end at the gate. The flow is
     implementation -> testing -> fixing -> flip mission done -> completion gate -> merge
   and the two loops in the middle are the whole reason the gate can be trusted: they run
   the authored TC cases against the built app and judge every screen against its design.
   Ending here would let a mission reach the gate having never been driven the way a user
   drives it.

   Nor does this flip the mission done — that is LAST, from the main session. The flip is
   the gate's trigger (a PostToolUse(Bash) hook on set-status.js), and a workflow subagent
   cannot dispatch the subagents the gate needs. Flipping it here marks the board done and
   swallows the check. Per-task flips above are unaffected: the hook exits on T<m>.<n>. */
return await finish({
  mission, built: true, next: 'testing',
  nextCommand: 'node .agents/mission-input.mjs ' + mission + '  ->  .octobots/campaigns/hotelbooking-mvp-konpeki-plaza-booking-funnel/workflows/testing/workflow.js',
  gateCommand,
  note: 'Tasks built and reviewed. Run TESTING next, then FIXING if it returns needsFixing. Only when both are green: run gateCommand from the main session to fire the completion gate, then merge.',
})
