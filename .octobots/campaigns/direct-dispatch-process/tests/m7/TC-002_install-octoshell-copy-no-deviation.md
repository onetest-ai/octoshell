---
id: TC-002
title: "Install into a copy of octoshell's own .claude: no deviation, no staging, no pending record"
mission: M7
covers: [M7-AC1, M7-AC3]
kind: cli
status: draft
priority: high
size: S
---

# TC-002: Install into a copy of octoshell's own .claude: no deviation, no staging, no pending record

**Mission:** M7 | **Priority:** high | **Kind:** cli | **Covers:** M7-AC1, M7-AC3

## Objective

A workspace whose skills are all shipped files is upgraded with no reconcile at all. Verifies M7-AC1 and M7-AC3 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP, SCRATCH; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

A `cp -R` copy of octoshell's real `.claude` + `.octobots` (v56, every SKILL.md byte-identical to the shipped v56 file).

## Commands

```bash
mkdir -p $WORK/octo1 && cp -R $OCTO/.claude $OCTO/.octobots $WORK/octo1/
$IP $WORK/octo1 > $WORK/octo1.json 2> $WORK/octo1.err; echo "exit=$?"; wc -c < $WORK/octo1.err
jq '{n: (.deviations | length), pending: .result.pending, after: .after | {upToDate, n: (.deviations | length)}}' $WORK/octo1.json
test ! -e $WORK/octo1/.octobots/pack-updates && echo "no pack-updates"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Install with the default | Exit 0; stderr has no `need reconcile` line |
| 2 | Read the JSON | 0 deviations, pending empty, after upToDate true with 0 deviations |
| 3 | Look for staging | "no pack-updates" |

## Expected Final State

Nothing is staged or recorded where nothing deviates.
