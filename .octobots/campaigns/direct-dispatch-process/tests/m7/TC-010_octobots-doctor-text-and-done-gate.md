---
id: TC-010
title: "octobots-doctor states the reconcile rules, and pack-reconcile.mjs done refuses an unfinished reconcile"
mission: M7
covers: [M7-AC7]
kind: unit
status: draft
priority: high
size: S
---

# TC-010: octobots-doctor states the reconcile rules, and pack-reconcile.mjs done refuses an unfinished reconcile

**Mission:** M7 | **Priority:** high | **Kind:** unit | **Covers:** M7-AC7

## Objective

The skill is the agent's manual, and the record can only be cleared by a finished reconcile. Verifies M7-AC7 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP, SCRATCH; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

The real shipped `skill/octobots-doctor/SKILL.md`; a git copy of solo staged by the real install (forks still `57-local`).

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/skill-conventions.test.ts test/pack-reconcile-script.test.ts --reporter=verbose
awk 'c>=2{print} /^---$/{c++}' $PACK/skill/octobots-doctor/SKILL.md | grep -n -E "ESCALATED|RESOLVED|Kept local|Taken from upstream|Conflicts|\+local|reconciled-from|merge|by lines|workflows/|CLAUDE_CONFIG_DIR|No upstream change since the base|UPSTREAM-CANDIDATES|doctor-acks|when unsure|who may merge"
grep -v -E '^import ' $PACK/skill/octobots-doctor/scripts/pack-reconcile.mjs | grep -c -E "mission-execution|mission-completion-gate|mission-planner|knowledge-explorer|workflow-designer"   # 0: its logic names no skill; the two imports from mission-planner/scripts are excluded
gitcopy solo10; W=$WORK/solo10; $IP $W > /dev/null 2>&1; PR=$W/.claude/skills/octobots-doctor/scripts/pack-reconcile.mjs
(cd $OCTO && node $PR list)
(cd $W && node $PR done mission-execution); echo "exit=$?"; jq '.skills | length' $W/.octobots/pack-updates/pending.json
shasum -a 256 $W/.octobots/pack-updates/pending.json > $WORK/p10.sha; (cd $W && node $PR done knowledge-explorer); echo "exit=$?"; shasum -a 256 -c $WORK/p10.sha
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the two vitest files | At least 1 test passed in each, none failed |
| 2 | Read the lines the grep points at | The classification, the full policy-conflict list with 'when unsure, escalate', ESCALATED with the whole live file untouched, never merge by lines, the DECISIONS.md sections and entry forms, the no-upstream-change line, the UPSTREAM-CANDIDATES.md form, `<N>+local` + `reconciled-from:`, workflows/ deleted only on a per-folder yes, the config-dir advice, doctor-acks.json for declined findings (keys {finding: "workflows", path: "campaigns/.../workflows"} relative to .octobots/, and {finding: "config-dir", path: ".claude"}) |
| 3 | Grep the script for skill names | 0 (it names no skill) |
| 4 | list run from octoshell's checkout | Prints the solo copy's two entries (the script resolves its workspace from its own location, not the cwd) |
| 5 | done on an unreconciled skill | exit 3 naming the marker (`57-local`, not `57+local`); pending.json still has 2 entries |
| 6 | done on a skill with no entry | exit 0, prints `no pending reconcile for knowledge-explorer`; pending.json `OK` (unchanged) |

## Expected Final State

Nothing clears a pending reconcile except a finished one.
