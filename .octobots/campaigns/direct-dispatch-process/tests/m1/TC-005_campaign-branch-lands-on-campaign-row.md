---
id: TC-005
title: "feat/edge-ops-ui and campaign/emulator-arena-loop land on campaign rows; campaign/sensor-assignment-uplift stays on its mission"
mission: M1
covers: [M1-AC5]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m1/runs/RUN-2026-10-05-001.md}
priority: critical
size: M
---

# TC-005: feat/edge-ops-ui and campaign/emulator-arena-loop land on campaign rows; campaign/sensor-assignment-uplift stays on its mission

**Mission:** M1 | **Priority:** critical | **Kind:** cli | **Covers:** M1-AC5

## Objective

feat/edge-ops-ui and campaign/emulator-arena-loop land on campaign rows; campaign/sensor-assignment-uplift stays on its mission. Verifies M1-AC5 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; the qa-m1 worktree from TC-001).
- Originals under $SOLO and $OCTO are untouched; this case writes only inside the worktree.

## Real data (pre-existing record)

Solo's real segments on `feat/edge-ops-ui` (28 on 2026-10-05; campaign edge-ops-ui has 10 missions) and `campaign/emulator-arena-loop` (1; emulator-arena-loop has 7 missions), both unattributed today (precedence step 6: slug contained, no mission resolved). `campaign/sensor-assignment-uplift` (7) is the negative: sensor-assignment-uplift M1 declares it (mission.yaml:17), so step 1 keeps it on that mission row.

## Commands

```bash
cd $SOLO/.claude/worktrees/qa-m1
node $PACK/tokenomics/collect.mjs --project-dir "$PWD" && node $PACK/tokenomics/rollup.mjs --project-dir "$PWD" --no-gh
node -e '
const fs=require("fs");
const seg=fs.readFileSync(".octobots/tokenomics/raw/segments.jsonl","utf8").trim().split("\n").map(JSON.parse);
const r=JSON.parse(fs.readFileSync(".octobots/tokenomics/runs.json","utf8"));
const turns=bs=>seg.filter(s=>bs.includes(s.branch)).reduce((a,s)=>a+(s.turns||0),0);
for (const [b,slug] of [["feat/edge-ops-ui","edge-ops-ui"],["campaign/emulator-arena-loop","emulator-arena-loop"]]) {
  const row=r.runs.find(x=>x.work_item_ref===slug);
  console.log(b,"segments:",seg.filter(s=>s.branch===b).length);
  console.log("  row:",row?JSON.stringify({work_item_level:row.work_item_level,parent_ref:row.parent_ref,mission_id:row._octobots.mission_id,branches:row._octobots.branches,turns:row.turns}):"MISSING");
  console.log("  row turns == turns of its branches:",!!row&&row.turns===turns(row._octobots.branches));
  console.log("  still in unattributed.branches:",r.unattributed.branches.includes(b));
  console.log("  on a mission row:",r.runs.some(x=>x._octobots&&x._octobots.mission_id&&(x._octobots.branches||[]).includes(b)));
}
const m1=r.runs.find(x=>x.parent_ref==="sensor-assignment-uplift"&&x._octobots&&x._octobots.mission_id==="M1");
console.log("campaign/sensor-assignment-uplift on sensor-assignment-uplift M1:",!!m1&&(m1._octobots.branches||[]).includes("campaign/sensor-assignment-uplift"));
console.log("on any campaign row:",r.runs.some(x=>x.work_item_level==="campaign"&&(x._octobots.branches||[]).includes("campaign/sensor-assignment-uplift")));'
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Count real segments on the two branches | Both > 0 (recorded: 28 and 1 on 2026-10-05); note the numbers |
| 2 | Run collect + rollup in the worktree | Exit 0 |
| 3 | Read the edge-ops-ui and emulator-arena-loop rows | Each exists in runs[] with work_item_level "campaign", work_item_ref = the slug, parent_ref null, _octobots.mission_id null, and its branch in _octobots.branches; row turns equal the summed turns of its branches |
| 4 | Check unattributed and the mission rows | Neither branch is in unattributed.branches or on any mission row |
| 5 | Check campaign/sensor-assignment-uplift | Still on sensor-assignment-uplift M1; on no campaign row |

## Expected Final State

Campaign-level branches sit once, on their campaign rows; a branch a mission declares stays on that mission.
