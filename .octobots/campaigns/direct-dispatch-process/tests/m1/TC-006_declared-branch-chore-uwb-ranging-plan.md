---
id: TC-006
title: "chore/uwb-ranging-plan is attributed once tokenomics.branches is declared"
mission: M1
covers: [M1-AC5]
kind: cli
status: draft
priority: high
size: M
---

# TC-006: chore/uwb-ranging-plan is attributed once tokenomics.branches is declared

**Mission:** M1 | **Priority:** high | **Kind:** cli | **Covers:** M1-AC5

## Objective

chore/uwb-ranging-plan is attributed once tokenomics.branches is declared. Verifies M1-AC5 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

the real `chore/uwb-ranging-plan` segments (5 on 2026-10-05) and the real uwb-ranging-ingest-vendor-v01 campaign.yaml (edited only inside the disposable worktree)

## Commands

```bash
cd $SOLO/.claude/worktrees/qa-m1
C=.octobots/campaigns/uwb-ranging-ingest-vendor-v01/campaign.yaml
# before: unattributed
node $PACK/tokenomics/collect.mjs --project-dir "$PWD" && node $PACK/tokenomics/rollup.mjs
node -e 'const r=require("./.octobots/tokenomics/runs.json");console.log("unattributed chore/uwb-ranging-plan:",(r.unattributed||[]).filter(s=>s.branch==="chore/uwb-ranging-plan").length)'
# declare (through the board scripts' shape: tokenomics.branches on the campaign)
node -e 'const f=require("fs");const c=f.readFileSync(process.argv[1],"utf8");f.writeFileSync(process.argv[1],c.includes("tokenomics:")?c:c.replace(/^notes:/m,"tokenomics:\n  branches: chore/uwb-ranging-plan\nnotes:"))' $C
node $PACK/tokenomics/rollup.mjs   # run rollup DIRECTLY: collect short-circuits at 0 new segments
node -e 'const r=require("./.octobots/tokenomics/runs.json");console.log(JSON.stringify((r.runs||r).filter(x=>/uwb-ranging/.test(x.campaign||"")&&x.mission==null)))'
node $PACK/skill/mission-planner/scripts/set-status.js .octobots/campaigns/uwb-ranging-ingest-vendor-v01 "M1 - Venue ingest mode and vendor integer ids" done || true; grep -n "branches" $C   # declaration survives a script write
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Before declaring: count chore/uwb-ranging-plan in runs.json unattributed | N > 0 (recorded: 5): the slug is not in the branch name |
| 2 | Add `tokenomics.branches: chore/uwb-ranging-plan` to the worktree's uwb campaign.yaml, run rollup.mjs directly | The N segments now sit on the uwb campaign-level row (mission: null) |
| 3 | Run an entity write on that campaign (set-status/add-doc) and re-read the yaml | `tokenomics.branches` is still there |

## Expected Final State

The declared branch attributes its segments to the uwb campaign-level row and survives script writes.
