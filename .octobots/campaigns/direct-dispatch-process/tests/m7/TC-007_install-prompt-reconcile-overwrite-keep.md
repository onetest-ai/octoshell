---
id: TC-007
title: "Install prompt on solo's workspace copy: Reconcile is the default, Cancel writes nothing, no agent is started, and the activation prompt stays quiet while pending"
mission: M7
covers: [M7-AC4]
kind: ui
status: blocked
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m7/runs/RUN-2026-10-05-001.md, note: pending user F5 run (tests/m7/manual/T7.4-F5-script.md)}
priority: high
size: M
---

# TC-007: Install prompt on solo's workspace copy: Reconcile is the default, Cancel writes nothing, no agent is started, and the activation prompt stays quiet while pending

**Mission:** M7 | **Priority:** high | **Kind:** ui | **Covers:** M7-AC4

## Objective

What the user sees, and that the extension only records the choice. Verifies M7-AC4 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP, SCRATCH; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

A git copy of solo (the two `57-local` forks). The vitest half builds its inputs from the shipped pack files (a synthetic unit check, stated). Manual half: Extension Development Host (F5) on $OCTO with the copy as the workspace; screenshots to tests/m7/evidence/; recorded as manual.

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/pack-deviation-prompt.test.ts --reporter=verbose
gitcopy solo-f5; (cd $WORK/solo-f5 && find .claude/skills -type f | sort | xargs shasum -a 256) > $WORK/f5.sha    # check later: (cd $WORK/solo-f5 && shasum -a 256 -c $WORK/f5.sha | grep -v ': OK$')
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run pack-deviation-prompt.test.ts | At least 1 test passed, none failed (exact text, completion messages, shouldPromptOnActivation table) |
| 2 | F5 with the copy; on the activation prompt choose Install | Before the hooks question, a modal: message `Octobots: 2 pack skill(s) in this workspace were changed locally.`; detail lists `• mission-execution: version 57-local (not a pack version)` and `• mission-completion-gate: version 57-local (not a pack version)` and the Reconcile / Overwrite / Keep mine / Cancel lines of M7 notes § Prompt text; buttons Reconcile (first, highlighted), Overwrite, Keep mine, Cancel; workflow-designer not listed |
| 3 | Cancel | No hooks or tools question follows; the shasum check prints nothing; no .octobots/pack-updates/ |
| 4 | Run Octobots: Install Octobots Pack, press Enter on the modal (the default) | Reconcile is applied: the completion message names both skills, .octobots/pack-updates/v57/ and octobots-doctor (and says the SessionStart hook is off if you declined the hooks); no terminal, chat or agent opens and the clipboard is unchanged; both forks still read `version: 57-local` |
| 5 | Developer: Reload Window | No activation prompt |
| 6 | Append one line to the copy's mission-execution SKILL.md, reload | The activation prompt shows once (the pending sha256 no longer matches) |
| 7 | Run the Install command, choose Keep mine; reload | The command always asks; after Keep mine no activation prompt on reload |

## Expected Final State

The user picks; the extension records and stages; nothing nags while a choice is in force.
