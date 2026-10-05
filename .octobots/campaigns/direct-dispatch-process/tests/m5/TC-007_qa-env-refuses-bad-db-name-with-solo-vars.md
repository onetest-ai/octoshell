---
id: TC-007
title: "qa-env.mjs edgeserver -- true with solo's real DSN var config: exit 3, command never runs"
mission: M5
covers: [M5-AC4]
kind: cli
status: draft
priority: critical
size: S
---

# TC-007: qa-env.mjs edgeserver -- true with solo's real DSN var config: exit 3, command never runs

**Mission:** M5 | **Priority:** critical | **Kind:** cli | **Covers:** M5-AC4

## Objective

qa-env.mjs edgeserver -- true with solo's real DSN var config: exit 3, command never runs. Verifies M5-AC4 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

a config naming solo's real vars EDGESERVER_POSTGRES_DSN + EDGESERVER_POSTGRES_SYNC_DSN (names copied from solo's real qa-db.sh)

## Commands

```bash
cat > $WORK/qa-env.json <<'EOF'
{"vars":{"EDGESERVER_POSTGRES_DSN":"postgresql+asyncpg://localhost/{db}","EDGESERVER_POSTGRES_SYNC_DSN":"postgresql://localhost/{db}"},"name_pattern":"^(qa_.+|.+_test)$"}
EOF
cd $WORK && node $PACK/skill/mission-execution/scripts/qa-env.mjs edgeserver -- touch $WORK/MARKER; echo "exit=$?"; test ! -e $WORK/MARKER && echo NOT_EXECUTED
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run qa-env.mjs with the real DB name `edgeserver` (the dev DB) | Exit 3; stderr says the name fails the pattern; MARKER absent (NOT_EXECUTED) |

## Expected Final State

The dev DB name is refused before exec.
