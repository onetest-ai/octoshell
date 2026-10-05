---
id: TC-002
title: "Legacy uwb TCs list as status unknown with the migrate suggestion; requirements alias works"
mission: M6
covers: [M6-AC2, M6-AC1]
kind: cli
status: draft
priority: critical
size: M
---

# TC-002: Legacy uwb TCs list as status unknown with the migrate suggestion; requirements alias works

**Mission:** M6 | **Priority:** critical | **Kind:** cli | **Covers:** M6-AC2, M6-AC1

## Objective

Legacy uwb TCs list as status unknown with the migrate suggestion; requirements alias works. Verifies M6-AC2 and M6-AC1 of M6 - Test cases are first-class on the board.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots uwb tests/m1 (22+ real TC files, legacy frontmatter) and m6 (no TCs)

## Commands

```bash
node $OCTO/apps/vscode-extension/scripts/qa/dump-tests.mjs $WORK/solo-octobots uwb-ranging-ingest-vendor-v01 | jq '[.[]|select(.mission=="M1")]|{n:length,status:(group_by(.status)|map({(.[0].status):length})),first:.[0]}'
node $PACK/skill/mission-planner/scripts/validate.js $WORK/solo-octobots/campaigns/uwb-ranging-ingest-vendor-v01/tests/m1/TC-003_set-ranging-mode-persists.md | grep -i "migrate\|set-test-status"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | List the uwb m1 TCs through the board library | All listed (count equals the real file count); status `unknown`; covers filled from `requirements`; mission M1 derived from the folder |
| 2 | Run validate on one real legacy TC | One-line warning suggesting `set-test-status.js --migrate`; exit code 0; not an error |
| 3 | List uwb m6 | Empty (no TCs), no error |

## Expected Final State

Legacy files are visible, honest (unknown) and never errors.
