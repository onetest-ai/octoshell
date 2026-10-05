---
id: TC-005
title: "campaign/sensor-assignment-uplift segments land on the campaign-level row"
mission: M1
covers: [M1-AC5]
kind: cli
status: draft
priority: critical
size: M
---

# TC-005: campaign/sensor-assignment-uplift segments land on the campaign-level row

**Mission:** M1 | **Priority:** critical | **Kind:** cli | **Covers:** M1-AC5

## Objective

campaign/sensor-assignment-uplift segments land on the campaign-level row. Verifies M1-AC5 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

the real `campaign/sensor-assignment-uplift` segments in solo's raw/segments.jsonl (7 on 2026-10-05) and the real sensor-assignment-uplift campaign.yaml

## Commands

```bash
cd $SOLO/.claude/worktrees/qa-m1
node $PACK/tokenomics/collect.mjs --project-dir "$PWD" && node $PACK/tokenomics/rollup.mjs
node -e 'const r=require("./.octobots/tokenomics/runs.json");const rows=(r.runs||r);const c=rows.filter(x=>/sensor-assignment-uplift/.test(x.campaign||"")&&x.mission==null);console.log(JSON.stringify(c.map(x=>({campaign:x.campaign,mission:x.mission,segments:x.segments&&x.segments.length||x.segmentCount,cost:x.cost})),null,1));const un=(r.unattributed||[]).filter(s=>s.branch==="campaign/sensor-assignment-uplift");console.log("still unattributed:",un.length)'
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Count real segments with branch campaign/sensor-assignment-uplift in segments.jsonl | N > 0 (recorded: 7 on 2026-10-05); note N |
| 2 | Run collect + rollup in the worktree | Exit 0 |
| 3 | Inspect runs.json for the sensor-assignment-uplift campaign-level row (mission: null) | A row exists with exactly N segments and a non-zero cost |
| 4 | Check those segments are not also spread over any mission row, and none remain unattributed | 0 still unattributed; mission rows have no segment from that branch |

## Expected Final State

All real campaign/sensor-assignment-uplift segments appear once, on the campaign-level row.
