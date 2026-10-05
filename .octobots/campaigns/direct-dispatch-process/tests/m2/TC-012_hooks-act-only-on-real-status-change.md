---
id: TC-012
title: "Gate and work-log hooks stay silent when set-status.js wrote nothing, even if the Bash call exited 0"
mission: M2
covers: [M2-AC8]
kind: cli
status: fail
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m2/runs/RUN-2026-10-05-001.md}
priority: high
size: S
---

# TC-012: Gate and work-log hooks stay silent when set-status.js wrote nothing, even if the Bash call exited 0

**Mission:** M2 | **Priority:** high | **Kind:** cli | **Covers:** M2-AC8

## Objective

Gate and work-log hooks stay silent when set-status.js wrote nothing, even if the Bash call exited 0. Verifies M2-AC8 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies in $WORK/solo after TC-001).
- Hooks run with `CLAUDE_PROJECT_DIR=$WORK/solo`, never against $SOLO.

## Real data (pre-existing record)

The solo copy's real uwb-ranging-ingest-vendor-v01 campaign: a title it does not contain ('M9 - No such mission': set-status.js exits 1 and writes nothing), and its real M1 ('M1 - Venue ingest mode and vendor integer ids', status done) as the control. The work log is the copy's real `.octobots/tokenomics/worklog.jsonl`.

## Commands

```bash
cd $WORK/solo
C=.octobots/campaigns/uwb-ranging-ingest-vendor-v01
WL=.octobots/tokenomics/worklog.jsonl; touch $WL
payload() { node -e 'console.log(JSON.stringify({session_id:"qa-m2-tc012",tool_name:"Bash",cwd:process.cwd(),tool_input:{command:process.argv[1]},tool_response:{exit_code:0,stdout:"",stderr:""}}))' "$1"; }
# (a) nothing written: the title does not exist, and `; echo` makes the Bash call exit 0
CMD="node .claude/skills/mission-planner/scripts/set-status.js $C \"M9 - No such mission\" done; echo"
sh -c "$CMD"; echo "chain exit=$?"
BEFORE=$(wc -l < $WL)
payload "$CMD" | CLAUDE_PROJECT_DIR=$WORK/solo node $PACK/hooks/mission-gate.mjs > $WORK/gate-a.out; echo "gate exit=$? bytes=$(wc -c < $WORK/gate-a.out)"
payload "$CMD" | CLAUDE_PROJECT_DIR=$WORK/solo node $PACK/hooks/work-log.mjs; echo "work-log exit=$?"
echo "worklog lines before=$BEFORE after=$(wc -l < $WL)"
# (b) control: a real mission whose YAML reads done
CMD2="node .claude/skills/mission-planner/scripts/set-status.js $C \"M1 - Venue ingest mode and vendor integer ids\" done"
payload "$CMD2" | CLAUDE_PROJECT_DIR=$WORK/solo node $PACK/hooks/mission-gate.mjs | grep -ci relay
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/octobots-mission-gate.test.ts test/octobots-work-log.test.ts --reporter=verbose
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the no-such-mission command chained with `; echo` | set-status.js prints 'no entity named ...'; the chain exits 0 |
| 2 | Feed that command's PostToolUse JSON to mission-gate.mjs | Exit 0 and 0 bytes printed: no gate directive |
| 3 | Feed it to work-log.mjs and compare worklog.jsonl line counts | Exit 0; line count unchanged |
| 4 | Control: feed the real uwb M1 `done` command to mission-gate.mjs | The directive is printed (relay count >= 1) |
| 5 | Run the two hook vitest files | At least 1 test passed in each |

## Expected Final State

A set-status.js call that changed nothing produces no gate directive and no work-log line; a real status change still does.

## Teardown

- None (the copy is discarded with $WORK).
