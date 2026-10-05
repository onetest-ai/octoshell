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

A config at `$WORK/qa7/.octobots/qa-env.json` (the path qa-env.mjs reads) naming solo's real vars EDGESERVER_POSTGRES_DSN and EDGESERVER_POSTGRES_SYNC_DSN (names copied from solo's real .agents/manual-qa/qa-db.sh), with the keys of T5.4's qa-env.example.json; `edgeserver` is solo's real dev DB name.

## Commands

```bash
mkdir -p $WORK/qa7/.octobots && cd $WORK/qa7
cat > .octobots/qa-env.json <<'JSON'
{"vars":{"EDGESERVER_POSTGRES_DSN":"postgresql+asyncpg://localhost/{db}","EDGESERVER_POSTGRES_SYNC_DSN":"postgresql://localhost/{db}"},"name_pattern":"^(qa_.+|.+_test)$"}
JSON
node $PACK/skill/mission-execution/scripts/qa-env.mjs edgeserver -- touch $WORK/qa7/MARKER; echo "exit=$?"; test ! -e $WORK/qa7/MARKER && echo NOT_EXECUTED
(cd $WORK && node $PACK/skill/mission-execution/scripts/qa-env.mjs qa_m5 -- touch $WORK/MARKER0; echo "no-config exit=$?"; test ! -e $WORK/MARKER0 && echo NOT_EXECUTED)
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run qa-env.mjs with the real dev DB name `edgeserver` | Exit 3; stderr says the name fails name_pattern; MARKER absent (NOT_EXECUTED) |
| 2 | Run it from $WORK, which has no .octobots/qa-env.json | Exit 3 naming the expected path; MARKER0 absent |

## Expected Final State

The dev DB name is refused before exec, and a missing config refuses too.
