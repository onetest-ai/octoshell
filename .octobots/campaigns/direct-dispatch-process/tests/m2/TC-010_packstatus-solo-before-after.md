---
id: TC-010
title: "packStatus on the solo copy: installed but not up to date with two local changes before; up to date with none after Overwrite"
mission: M2
covers: [M2-AC2, M2-AC10]
kind: unit
status: draft
priority: medium
size: S
---

# TC-010: packStatus on the solo copy: installed but not up to date with two local changes before; up to date with none after Overwrite

**Mission:** M2 | **Priority:** medium | **Kind:** unit | **Covers:** M2-AC2, M2-AC10

## Objective

packStatus describes solo's forks as local changes, not as a missing install, and reports a clean pack after Overwrite. Verifies M2-AC2 and M2-AC10 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

A fresh copy of solo's real `.claude/skills`: mission-execution and mission-completion-gate are `version: 57-local`; mission-planner, knowledge-explorer and workflow-designer are `version: 56` and byte-identical to the shipped v56 files (sha256 checked 2026-10-05).

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/octobots-skill.test.ts test/pack-local-changes.test.ts --reporter=verbose
# real-data half: a FRESH copy (TC-001 already upgraded $WORK/solo)
mkdir -p $WORK/solo2 && cp -R $SOLO/.claude $SOLO/.octobots $WORK/solo2/
grep -h "^version:" $WORK/solo2/.claude/skills/*/SKILL.md | sort | uniq -c
node $OCTO/apps/vscode-extension/scripts/qa/install-pack.mjs $WORK/solo2 --local-changes=overwrite > $WORK/solo2.json
jq '{before: .before | {installed, upToDate, upToDateExceptLocal, n: (.localChanges | length)}, after: .after | {installed, upToDate, n: (.localChanges | length)}}' $WORK/solo2.json
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the two vitest files | At least 1 test passed in each, none failed |
| 2 | `.before` on the fresh solo copy | installed: true (a `57-local` skill counts as present), upToDate: false, n: 2 |
| 3 | `.after` | installed: true, upToDate: true, n: 0; every pack skill version is 57 |

## Expected Final State

The activation prompt has the right inputs for solo before and after the upgrade.
