---
id: TC-014
title: "Local-changes modal text and buttons on solo's workspace copy; Cancel writes nothing; Keep stops the activation prompt until the fork changes"
mission: M2
covers: [M2-AC9, M2-AC10]
kind: ui
status: draft
priority: high
size: M
---

# TC-014: Local-changes modal text and buttons on solo's workspace copy; Cancel writes nothing; Keep stops the activation prompt until the fork changes

**Mission:** M2 | **Priority:** high | **Kind:** ui | **Covers:** M2-AC9, M2-AC10

## Objective

What the user sees (campaign decision 13), and that the activation prompt does not nag after Keep. Verifies M2-AC9 and M2-AC10 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.
- Manual half: Extension Development Host (F5) on $OCTO with $WORK/solo-f5 as the workspace; screenshots to tests/m2/evidence/. VS Code is not drivable by Playwright MCP, so this half is recorded as manual.

## Real data (pre-existing record)

A copy of solo's real `.claude` + `.octobots` (the two `version: 57-local` forks). The vitest half builds its inputs from the shipped pack files (a synthetic unit check, stated).

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/pack-local-changes.test.ts --reporter=verbose
mkdir -p $WORK/solo-f5 && cp -R $SOLO/.claude $SOLO/.octobots $WORK/solo-f5/
(cd $WORK/solo-f5 && find .claude -type f | sort | xargs shasum -a 256) > $WORK/f5.sha    # check later with: (cd $WORK/solo-f5 && shasum -a 256 -c $WORK/f5.sha | grep -v ': OK$')
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run pack-local-changes.test.ts | At least 1 test passed, none failed (incl. the exact prompt text and the shouldPromptOnActivation table) |
| 2 | F5 with $WORK/solo-f5; on the activation prompt choose Install | Before the hooks question, a modal: message `Octobots: 2 pack skill(s) in this workspace were changed locally.`; detail lists exactly `• mission-execution: version 57-local (not a pack version)` and `• mission-completion-gate: version 57-local (not a pack version)` and the Overwrite / Keep my changes / Cancel lines of M2 notes § Local-fork protection; buttons Overwrite, Keep my changes and Cancel. workflow-designer is not listed |
| 3 | Cancel | No hooks or tools question follows; the shasum check prints nothing (no file under .claude changed) |
| 4 | Run Octobots: Install Octobots Pack, choose Keep my changes, answer the remaining questions | The completion message names the kept skills; both forks still read `version: 57-local` |
| 5 | Developer: Reload Window | No activation prompt |
| 6 | Append one line to $WORK/solo-f5/.claude/skills/mission-execution/SKILL.md, reload | The activation prompt shows once (the kept sha256 no longer matches) |
| 7 | Run the Install command again | The modal asks again (the explicit command always asks) |

## Expected Final State

The user sees exactly which skills would be overwritten, Cancel is safe, and Keep is remembered without nagging.
