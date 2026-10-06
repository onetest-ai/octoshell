---
id: TC-010
title: "packStatus on the solo copy: not up to date before the install; up to date after"
mission: M2
covers: [M2-AC2]
kind: unit
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m2/runs/RUN-2026-10-05-001.md}
priority: medium
size: S
---

# TC-010: packStatus on the solo copy: not up to date before the install; up to date after

**Mission:** M2 | **Priority:** medium | **Kind:** unit | **Covers:** M2-AC2

## Objective

packStatus reports solo's copy as not up to date before the install and as a clean v57 pack after it (M2 overwrites the forks; describing them as deviations is M7-AC1). Verifies M2-AC2 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

A fresh copy of solo's real `.claude/skills`: mission-execution and mission-completion-gate are `version: 57-local`; mission-planner, knowledge-explorer and workflow-designer are `version: 56` and byte-identical to the shipped v56 files (sha256 checked 2026-10-05).

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/octobots-skill.test.ts --reporter=verbose
# real-data half: a FRESH copy (TC-001 already upgraded $WORK/solo)
mkdir -p $WORK/solo2 && cp -R $SOLO/.claude $SOLO/.octobots $WORK/solo2/
grep -h "^version:" $WORK/solo2/.claude/skills/*/SKILL.md | sort | uniq -c
node $OCTO/apps/vscode-extension/scripts/qa/install-pack.mjs $WORK/solo2 > $WORK/solo2.json
jq '{before: .before | {installed, upToDate}, after: .after | {installed, upToDate}}' $WORK/solo2.json
grep -h "^version:" $WORK/solo2/.claude/skills/*/SKILL.md | sort | uniq -c
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the vitest file | At least 1 test passed, none failed |
| 2 | `.before` on the fresh solo copy | upToDate: false (installed false: `57-local` parses to no version until M7) |
| 3 | `.after` | installed: true, upToDate: true; every pack skill version is 57 |

## Expected Final State

The activation prompt has the right inputs for solo before and after the upgrade; M7 TC-001 refines `.before` into deviations.
