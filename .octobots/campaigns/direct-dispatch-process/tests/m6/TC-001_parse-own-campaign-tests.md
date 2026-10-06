---
id: TC-001
title: "Board library parses this campaign's own tests/m1..m6 into TestCase entities"
mission: M6
covers: [M6-AC1]
kind: unit
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m6/runs/RUN-2026-10-06-001.md}
priority: critical
size: M
---

# TC-001: Board library parses this campaign's own tests/m1..m6 into TestCase entities

**Mission:** M6 | **Priority:** critical | **Kind:** unit | **Covers:** M6-AC1

## Objective

Board library parses this campaign's own tests/m1..m6 into TestCase entities. Verifies M6-AC1 of M6 - Test cases are first-class on the board.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

this campaign's real tests/m1..m6 TC files (new frontmatter), plus README.md/runs/evidence siblings that must NOT be parsed

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/board exec vitest run test/test-cases-own-campaign.test.ts --reporter=verbose
node $OCTO/apps/vscode-extension/scripts/qa/dump-tests.mjs $OCTO/.octobots direct-dispatch-process | jq 'group_by(.mission)|map({m:.[0].mission,n:length})'
for d in $OCTO/.octobots/campaigns/direct-dispatch-process/tests/m*/; do echo "$(basename $d) $(ls $d | grep -c '^TC-.*\.md$')"; done
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run test-cases-own-campaign.test.ts, then dump the campaign's tests with dump-tests.mjs | At least 1 test passed; one TestCase per TC-*.md; counts per mission equal the file counts on disk |
| 2 | Check each entity's fields | id equals the filename prefix; mission equals the folder; covers is the frontmatter list; kind in api|ui|cli|unit; status draft|ready|pass|fail|blocked; path is the file |
| 3 | Check README.md, runs/, evidence/ | Not parsed (no entity) |
| 4 | Check the YAML entity ids of the same campaign | Unchanged vs before parsing tests (no new EntityKind) |

## Expected Final State

Every TC file becomes exactly one TestCase; nothing else does.
