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

solo's real var names with the SYNC template deliberately missing {db} (the exact failure that migrated the real dev DB on M2/M3 QA: only one DSN overridden)

## Commands

```bash
cat > $WORK/qa-env.bad.json <<'EOF'
{"vars":{"EDGESERVER_POSTGRES_DSN":"postgresql+asyncpg://localhost/{db}","EDGESERVER_POSTGRES_SYNC_DSN":"postgresql://localhost/edgeserver"},"name_pattern":"^qa_.+$"}
EOF
cd $WORK && cp qa-env.bad.json .octobots-qa-env.json; node $PACK/skill/mission-execution/scripts/qa-env.mjs qa_m5 -- touch $WORK/MARKER2; echo "exit=$?"; test ! -e $WORK/MARKER2 && echo NOT_EXECUTED
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run with a config whose sync template has no {db} | Exit 3 naming the offending var; MARKER2 absent |

## Expected Final State

Refuses to run when any declared var could point at the real DB.
