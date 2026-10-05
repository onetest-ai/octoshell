---
id: TC-006
title: "chore/uwb-ranging-plan lands on the uwb campaign row once the campaign declares it; the declaration survives a script write"
mission: M1
covers: [M1-AC5]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m1/runs/RUN-2026-10-05-001.md}
priority: high
size: M
---

# TC-006: chore/uwb-ranging-plan lands on the uwb campaign row once the campaign declares it; the declaration survives a script write

**Mission:** M1 | **Priority:** high | **Kind:** cli | **Covers:** M1-AC5

## Objective

chore/uwb-ranging-plan lands on the uwb campaign row once the campaign declares it; the declaration survives a script write. Verifies M1-AC5 (precedence step 5) of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; the qa-m1 worktree from TC-001).
- The campaign.yaml edited here is the worktree's copy, never $SOLO's.

## Real data (pre-existing record)

The real `chore/uwb-ranging-plan` segments (5 on 2026-10-05; the branch does not contain the slug uwb-ranging-ingest-vendor-v01, so it is unattributed today) and the real uwb-ranging-ingest-vendor-v01 campaign.yaml in the disposable worktree.

## Commands

```bash
cd $SOLO/.claude/worktrees/qa-m1
C=.octobots/campaigns/uwb-ranging-ingest-vendor-v01/campaign.yaml
node $PACK/tokenomics/collect.mjs --project-dir "$PWD" && node $PACK/tokenomics/rollup.mjs --project-dir "$PWD" --no-gh
node -e 'const r=require(process.argv[1]+"/.octobots/tokenomics/runs.json");console.log("before: in unattributed.branches:",r.unattributed.branches.includes("chore/uwb-ranging-plan"))' "$PWD"
# declare it with the board's own serializer (campaign tokenomics is modelled since T1.3)
node --input-type=module -e 'const io=await import(process.argv[1]);const fs=await import("node:fs");const f=io.readEntity(process.argv[2],"yaml");f.tokenomics={...(f.tokenomics||{}),branches:["chore/uwb-ranging-plan"]};fs.writeFileSync(process.argv[2],io.dumpEntity("campaign",f))' $PACK/skill/mission-planner/scripts/entity-io.mjs "$PWD/$C"
node $PACK/tokenomics/rollup.mjs --project-dir "$PWD" --no-gh     # rollup directly: collect short-circuits at 0 new segments
node -e 'const r=require(process.argv[1]+"/.octobots/tokenomics/runs.json");const row=r.runs.find(x=>x.work_item_ref==="uwb-ranging-ingest-vendor-v01");console.log(row?JSON.stringify({work_item_level:row.work_item_level,parent_ref:row.parent_ref,mission_id:row._octobots.mission_id,branches:row._octobots.branches}):"MISSING");console.log("still in unattributed.branches:",r.unattributed.branches.includes("chore/uwb-ranging-plan"))' "$PWD"
# a script write on the campaign keeps the declaration
node $PACK/skill/mission-planner/scripts/add-doc.js "$PWD/$(dirname $C)" "QA probe" docs/qa-probe.md && grep -n -A2 "^tokenomics:" $C
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Before declaring: check unattributed.branches | `chore/uwb-ranging-plan` is listed (recorded: 5 segments) |
| 2 | Add `tokenomics.branches: [chore/uwb-ranging-plan]` to the worktree's uwb campaign.yaml and run rollup.mjs | A runs[] row with work_item_ref uwb-ranging-ingest-vendor-v01, work_item_level "campaign", parent_ref null, mission_id null, listing the branch; the branch is gone from unattributed.branches |
| 3 | Run add-doc.js on that campaign and re-read the yaml | `tokenomics:` still holds `branches` with chore/uwb-ranging-plan |

## Expected Final State

The declared branch attributes its segments to the uwb campaign row, and the declaration survives a script write.
