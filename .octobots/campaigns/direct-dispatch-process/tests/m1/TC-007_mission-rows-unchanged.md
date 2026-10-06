---
id: TC-007
title: "No mission row loses a segment: v56 vs v57 rollup over the same real segments"
mission: M1
covers: [M1-AC5]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m1/runs/RUN-2026-10-05-001.md}
priority: critical
size: S
---

# TC-007: No mission row loses a segment: v56 vs v57 rollup over the same real segments

**Mission:** M1 | **Priority:** critical | **Kind:** cli | **Covers:** M1-AC5

## Objective

No mission row loses a segment: v56 vs v57 rollup over the same real segments. Verifies M1-AC5 ('no segment leaves the mission row it was attributed to before the change') of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, OLD; the qa-m1 worktree from TC-001; the v56 tokenomics extracted to $OLD).
- Originals under $SOLO and $OCTO are untouched; this case writes only inside the worktree and $WORK.

## Real data (pre-existing record)

Solo's real segments, collected once and rolled up by both the v56 rollup.mjs (origin/main) and the v57 one, so the comparison is attribution-only (same segments, same flags). Every solo mission row is in scope; the uwb rows are M1-M4 and M6 (5 rows; M5 is cancelled and has no row).

## Commands

```bash
cd $SOLO/.claude/worktrees/qa-m1
node $PACK/tokenomics/collect.mjs --project-dir "$PWD"                       # one collection shared by both rollups
node $OLD/rollup.mjs --project-dir "$PWD" --no-gh && cp .octobots/tokenomics/runs.json $WORK/runs.v56.json
node $PACK/tokenomics/rollup.mjs --project-dir "$PWD" --no-gh && cp .octobots/tokenomics/runs.json $WORK/runs.v57.json
node -e '
const a=require(process.argv[1]).runs, b=require(process.argv[2]).runs;
const isMission=x=>x._octobots&&x._octobots.mission_id;
const tok=x=>Object.values(x.tokens||{}).reduce((s,v)=>s+v,0);
const nb=new Map(b.map(x=>[x.work_item_ref,x]));
let lost=0; const grew=[];
for (const x of a.filter(isMission)) {
  const y=nb.get(x.work_item_ref);
  if (!y||y.sessions<x.sessions||y.turns<x.turns||tok(y)<tok(x)) { lost++; console.log("LOST",x.work_item_ref); }
  else if (y.turns>x.turns) grew.push(x.work_item_ref);
}
console.log("v56 mission rows:",a.filter(isMission).length,"| lost:",lost,"| grew:",grew.join(",")||"none");
console.log("uwb mission rows:",b.filter(x=>x.parent_ref==="uwb-ranging-ingest-vendor-v01"&&isMission(x)).map(x=>x._octobots.mission_id).sort().join(" "));
console.log("campaign rows:",b.filter(x=>x.work_item_level==="campaign").map(x=>x.work_item_ref).join(","));' $WORK/runs.v56.json $WORK/runs.v57.json
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Collect once, then run the v56 and the v57 rollup over the same segments | Both exit 0 |
| 2 | For every v56 mission row, compare sessions, turns and summed tokens with the v57 row of the same work_item_ref | lost: 0 (no row missing, none smaller) |
| 3 | List rows that grew | Any growth comes from precedence step 4 (worklog); the run report names the worklog session(s) that explain each grown row |
| 4 | List the uwb mission rows | M1 M2 M3 M4 M6 (5 rows) |
| 5 | List the campaign rows | Only campaign-level rows were added (at least edge-ops-ui and emulator-arena-loop) |

## Expected Final State

No segment left the mission it was attributed to under v56; v57 only adds campaign rows and worklog-attributed segments.
