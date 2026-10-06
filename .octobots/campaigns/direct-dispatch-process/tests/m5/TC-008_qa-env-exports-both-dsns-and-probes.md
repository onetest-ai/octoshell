---
id: TC-008
title: "qa-env.mjs qa_m5 -- env exports BOTH vars at qa_m5; probe against local Postgres prints qa_m5"
mission: M5
covers: [M5-AC4]
kind: cli
status: blocked
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m5/runs/RUN-2026-10-06-001.md}
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

Solo's real var names in `$WORK/qa8/.octobots/qa-env.json`, and a clone DB named qa_m5 on the local Postgres (created the way solo does: `CREATE DATABASE qa_m5 TEMPLATE ...`). The probe halves are UNREACHABLE if no local Postgres; never stub the probe.

## Commands

```bash
mkdir -p $WORK/qa8/.octobots && cd $WORK/qa8
cat > .octobots/qa-env.json <<'JSON'
{"vars":{"EDGESERVER_POSTGRES_DSN":"postgresql+asyncpg://localhost/{db}","EDGESERVER_POSTGRES_SYNC_DSN":"postgresql://localhost/{db}"},"name_pattern":"^qa_.+$"}
JSON
node $PACK/skill/mission-execution/scripts/qa-env.mjs qa_m5 -- env | grep EDGESERVER_POSTGRES
# matching probe: prints the DB the sync DSN points at
cat > .octobots/qa-env.json <<'JSON'
{"vars":{"EDGESERVER_POSTGRES_DSN":"postgresql+asyncpg://localhost/{db}","EDGESERVER_POSTGRES_SYNC_DSN":"postgresql://localhost/{db}"},"name_pattern":"^qa_.+$","probe":"psql \"$EDGESERVER_POSTGRES_SYNC_DSN\" -Atc 'select current_database()'"}
JSON
node $PACK/skill/mission-execution/scripts/qa-env.mjs qa_m5 -- true; echo "exit=$?"
# mismatching probe: always prints postgres
cat > .octobots/qa-env.json <<'JSON'
{"vars":{"EDGESERVER_POSTGRES_DSN":"postgresql+asyncpg://localhost/{db}","EDGESERVER_POSTGRES_SYNC_DSN":"postgresql://localhost/{db}"},"name_pattern":"^qa_.+$","probe":"psql -d postgres -Atc 'select current_database()'"}
JSON
node $PACK/skill/mission-execution/scripts/qa-env.mjs qa_m5 -- touch $WORK/qa8/MARKER; echo "exit=$?"; test ! -e $WORK/qa8/MARKER && echo NOT_EXECUTED
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run with qa_m5 and `env` (no probe) | Both EDGESERVER_POSTGRES_DSN and EDGESERVER_POSTGRES_SYNC_DSN printed, both ending in /qa_m5; `qa_m5` printed to stderr as the target DB |
| 2 | Matching probe against local Postgres | The probe prints qa_m5; the command runs; exit 0 |
| 3 | Mismatching probe: `psql -d postgres -Atc 'select current_database()'` prints `postgres`, not qa_m5 | Exit 4; MARKER absent (command not run) |
| 4 | No Postgres running | Steps 2-3 recorded UNREACHABLE (status blocked, reason in the RUN file); do NOT substitute a stub |

## Expected Final State

Both vars exported at the QA DB; a probe that names another DB exits 4 before exec.
