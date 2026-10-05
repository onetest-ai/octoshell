---
id: TC-009
title: "Config whose sync-DSN template lacks {db}: exit 3 before exec"
mission: M5
covers: [M5-AC4]
kind: cli
status: draft
priority: high
size: S
---

# TC-009: Config whose sync-DSN template lacks {db}: exit 3 before exec

**Mission:** M5 | **Priority:** high | **Kind:** cli | **Covers:** M5-AC4

## Objective

Config whose sync-DSN template lacks {db}: exit 3 before exec. Verifies M5-AC4 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

Solo's real var names in `$WORK/qa9/.octobots/qa-env.json`, with the SYNC template deliberately missing {db}: the exact failure that migrated the real dev DB on M2/M3 QA (only one DSN overridden).

## Commands

```bash
mkdir -p $WORK/qa9/.octobots && cd $WORK/qa9
cat > .octobots/qa-env.json <<'JSON'
{"vars":{"EDGESERVER_POSTGRES_DSN":"postgresql+asyncpg://localhost/{db}","EDGESERVER_POSTGRES_SYNC_DSN":"postgresql://localhost/edgeserver"},"name_pattern":"^qa_.+$"}
JSON
node $PACK/skill/mission-execution/scripts/qa-env.mjs qa_m5 -- touch $WORK/qa9/MARKER2; echo "exit=$?"; test ! -e $WORK/qa9/MARKER2 && echo NOT_EXECUTED
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run with a config whose sync template has no {db} | Exit 3; stderr names EDGESERVER_POSTGRES_SYNC_DSN; MARKER2 absent |

## Expected Final State

Refuses to run when any declared var could point at the real DB.
