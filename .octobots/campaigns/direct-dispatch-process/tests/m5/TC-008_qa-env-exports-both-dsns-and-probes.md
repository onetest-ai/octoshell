---
id: TC-008
title: "qa-env.mjs qa_m5 -- env exports BOTH vars at qa_m5; probe against local Postgres prints qa_m5"
mission: M5
covers: [M5-AC4]
kind: cli
status: draft
priority: high
size: M
---

# TC-008: qa-env.mjs qa_m5 -- env exports BOTH vars at qa_m5; probe against local Postgres prints qa_m5

**Mission:** M5 | **Priority:** high | **Kind:** cli | **Covers:** M5-AC4

## Objective

qa-env.mjs qa_m5 -- env exports BOTH vars at qa_m5; probe against local Postgres prints qa_m5. Verifies M5-AC4 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

a clone DB named qa_m5 on the local Postgres (created the way solo does: CREATE DATABASE qa_m5 TEMPLATE ...); UNREACHABLE for the probe half if no Postgres

## Commands

```bash
cd $WORK && node $PACK/skill/mission-execution/scripts/qa-env.mjs qa_m5 -- env | grep EDGESERVER_POSTGRES
# probe half (config has "probe": "psql \"$EDGESERVER_POSTGRES_SYNC_DSN\" -Atc 'select current_database()'"):
node $PACK/skill/mission-execution/scripts/qa-env.mjs qa_m5 -- true; echo "exit=$?"
node $PACK/skill/mission-execution/scripts/qa-env.mjs qa_other -- true; echo "exit=$?   (probe prints qa_m5 vs <db>=qa_other when DB qa_other missing -> exit 4 or psql error)"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run with qa_m5 and `env` | Both EDGESERVER_POSTGRES_DSN and EDGESERVER_POSTGRES_SYNC_DSN printed, both ending in /qa_m5; target DB printed to stderr |
| 2 | Run the probe against local Postgres | Probe prints qa_m5; command runs; exit 0 |
| 3 | Probe returns a different name (point the template at another DB) | Exit 4 without exec |
| 4 | No Postgres running | Probe half recorded UNREACHABLE; do NOT substitute a stub |

## Expected Final State

Both vars exported at the QA DB; mismatching probe exits 4.
