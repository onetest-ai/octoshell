---
id: TC-001
title: "add-tests.js on octoshell octograph m6 (5 ACs, no tests): README with M6-AC1..5 and the document linked"
mission: M4
covers: [M4-AC1]
kind: cli
status: draft
priority: critical
size: M
---

# TC-001: add-tests.js on octoshell octograph m6 (5 ACs, no tests): README with M6-AC1..5 and the document linked

**Mission:** M4 | **Priority:** critical | **Kind:** cli | **Covers:** M4-AC1

## Objective

add-tests.js on octoshell octograph m6 (5 ACs, no tests): README with M6-AC1..5 and the document linked. Verifies M4-AC1 of M4 - Functional test cases are a gate-run unit of every mission.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/octo-octobots octograph `m6-extension-bridge` (5 real ACs, no tests/ folder, documents link only to docs/superpowers/plans/...)

## Commands

```bash
C=$WORK/octo-octobots/campaigns/octograph-code-architecture-graph
node $PACK/skill/mission-planner/scripts/add-tests.js $C/missions/m6-extension-bridge; echo "exit=$?"
cat $C/tests/m6/README.md | head -40
grep -n "M6-AC" $C/tests/m6/README.md
grep -n -A1 "label: M6 functional test cases" $C/missions/m6-extension-bridge/mission.yaml
ls $PACK/skill/mission-planner/templates/TC-template.md
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run add-tests.js on the real m6 mission dir | Exit 0 |
| 2 | Read tests/m6/README.md | Table has rows M6-AC1..M6-AC5 (matching the real AC count); sections 'Shared preconditions', 'Pre-existing records', 'Assumptions to confirm' exist |
| 3 | Read mission.yaml documents | New document 'M6 functional test cases' with target `.octobots/campaigns/octograph-code-architecture-graph/tests/m6/README.md` (existing 'M6 plan' document untouched) |
| 4 | Check the TC template | Exists and carries the frontmatter fields id, title, mission, covers, kind, status |

## Expected Final State

Scaffolded and linked; nothing else on the mission changed.
