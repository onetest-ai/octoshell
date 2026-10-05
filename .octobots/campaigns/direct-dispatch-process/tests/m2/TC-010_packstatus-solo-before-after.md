---
id: TC-010
title: "packStatus on the solo copy: not up to date before install (57-local unparseable), up to date after"
mission: M2
covers: [M2-AC2]
kind: unit
status: draft
priority: medium
size: S
---

# TC-010: packStatus on the solo copy: not up to date before install (57-local unparseable), up to date after

**Mission:** M2 | **Priority:** medium | **Kind:** unit | **Covers:** M2-AC2

## Objective

packStatus on the solo copy: not up to date before install (57-local unparseable), up to date after. Verifies M2-AC2 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

copy of solo's real `.claude/skills` with the two `version: 57-local` forks

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/octobots-skill.test.ts --reporter=verbose
# real-data half: a FRESH copy (TC-001 already upgraded $WORK/solo)
mkdir -p $WORK/solo2 && cp -R $SOLO/.claude $WORK/solo2/
grep -h "^version:" $WORK/solo2/.claude/skills/*/SKILL.md | sort | uniq -c
node $OCTO/apps/vscode-extension/scripts/qa/install-pack.mjs $WORK/solo2 | jq '{before: .before, after: .after}'
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run octobots-skill.test.ts | At least 1 test passed, incl. the 57-local before/after case |
| 2 | `.before` on the fresh solo copy | upToDate: false (the `57-local` forks parse to null) |
| 3 | `.after` | upToDate: true; every pack skill version is 57 |

## Expected Final State

The activation prompt is correct for solo before and after the upgrade.
