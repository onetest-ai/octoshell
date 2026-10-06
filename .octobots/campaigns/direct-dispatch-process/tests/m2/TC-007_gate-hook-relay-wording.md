---
id: TC-007
title: "Gate hook on `set-status.js <uwb m1> ... done` says the orchestrator relays Rio's questions"
mission: M2
covers: [M2-AC7]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m2/runs/RUN-2026-10-05-001.md}
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
cd $WORK/solo                      # the hook exits silently when the project has no .octobots
CMD='node .claude/skills/mission-planner/scripts/set-status.js .octobots/campaigns/uwb-ranging-ingest-vendor-v01 "M1 - Venue ingest mode and vendor integer ids" done'
node -e 'console.log(JSON.stringify({session_id:"qa-m2-tc007",tool_name:"Bash",cwd:process.cwd(),tool_input:{command:process.argv[1]},tool_response:{exit_code:0,stdout:"",stderr:""}}))' "$CMD" \
  | CLAUDE_PROJECT_DIR=$WORK/solo node $PACK/hooks/mission-gate.mjs | tee $WORK/hook.out
grep -ci "relay" $WORK/hook.out; grep -ci "directly" $WORK/hook.out
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | From the solo copy, pipe the PostToolUse JSON for that command into mission-gate.mjs (CLAUDE_PROJECT_DIR = the copy; uwb M1's YAML already reads done, so AC8's re-read lets it act) | Hook exits 0 and prints a directive |
| 2 | Check wording | Contains that the orchestrator relays Rio's questions to the devs (relay count >= 1); 'directly' count is 0 |
| 3 | Check phases 1-3 named in the directive | Match the gate skill's phases (tests+coverage, black-box QA, critical review) |

## Expected Final State

Directive says relay, never 'directly'.
