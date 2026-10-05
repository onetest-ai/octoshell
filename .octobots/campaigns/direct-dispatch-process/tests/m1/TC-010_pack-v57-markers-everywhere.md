---
id: TC-010
title: "All pack markers, SKILL.md versions and the constant read 57; payload hash present"
mission: M1
covers: [M1-AC7]
kind: cli
status: draft
priority: high
size: S
---

# TC-010: All pack markers, SKILL.md versions and the constant read 57; payload hash present

**Mission:** M1 | **Priority:** high | **Kind:** cli | **Covers:** M1-AC7

## Objective

All pack markers, SKILL.md versions and the constant read 57; payload hash present. Verifies M1-AC7 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

the real shipped pack under apps/vscode-extension/resources/octobots-pack and graph-payload-versions.json; solo's 57-local forks are the contrast

## Commands

```bash
cd $OCTO && grep -n "OCTOBOTS_PACK_VERSION" apps/vscode-extension/src/host/octobots-skill.ts
grep -rn "^version:" $PACK/skill/*/SKILL.md
grep -rn "octobots-pack-version" $PACK/hooks/primer.mjs $PACK/tokenomics/run.mjs $PACK/tokenomics/backfill-worklog-sha.mjs $PACK/statusline/statusline.sh
head -3 $PACK/graph/octograph.mjs; jq 'has("57")' apps/vscode-extension/scripts/graph-payload-versions.json
pnpm --filter @octoshell/vscode-extension test -- graph-payload && pnpm --filter @octoshell/vscode-extension build
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Read the constant and every SKILL.md version | All 57 (no 56, no 57-local) |
| 2 | Read the 4 hand markers and the octograph banner | All 57 |
| 3 | Check graph-payload-versions.json | Has a `57` entry; graph-payload.test.ts and the extension build (--verify) green |

## Expected Final State

A single consistent v57 across constant, skills, markers and payload.
