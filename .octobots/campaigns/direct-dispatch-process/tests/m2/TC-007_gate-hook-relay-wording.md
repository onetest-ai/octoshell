---
id: TC-007
title: "Gate hook on `set-status.js <uwb m1> ... done` says the orchestrator relays Rio's questions"
mission: M2
covers: [M2-AC7]
kind: cli
status: draft
priority: critical
size: S
---

# TC-007: Gate hook on `set-status.js <uwb m1> ... done` says the orchestrator relays Rio's questions

**Mission:** M2 | **Priority:** critical | **Kind:** cli | **Covers:** M2-AC7

## Objective

Gate hook on `set-status.js <uwb m1> ... done` says the orchestrator relays Rio's questions. Verifies M2-AC7 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

solo uwb mission `m1-venue-ingest-mode-and-vendor-integer-ids` (real mission name 'M1 - Venue ingest mode and vendor integer ids') as the command target

## Commands

```bash
CMD='node .claude/skills/mission-planner/scripts/set-status.js .octobots/campaigns/uwb-ranging-ingest-vendor-v01 "M1 - Venue ingest mode and vendor integer ids" done'
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"'"$(echo $CMD | sed 's/"/\\"/g')"'"},"tool_response":{"exit_code":0}}' | node $PACK/hooks/mission-gate.mjs | tee $WORK/hook.out
grep -ci "relay" $WORK/hook.out; grep -ci "directly" $WORK/hook.out
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Pipe the PostToolUse JSON for that command into mission-gate.mjs | Hook exits 0 and prints a directive |
| 2 | Check wording | Contains that the orchestrator relays Rio's questions to the devs (relay count >= 1); 'directly' count is 0 |
| 3 | Check phases 1-3 named in the directive | Match the gate skill's phases (tests+coverage, black-box QA, critical review) |

## Expected Final State

Directive says relay, never 'directly'.
