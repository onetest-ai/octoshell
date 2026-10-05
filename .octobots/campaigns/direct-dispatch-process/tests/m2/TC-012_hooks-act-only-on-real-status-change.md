---
id: TC-012
title: "Gate and work-log hooks stay silent when set-status.js wrote nothing, even if the Bash call exited 0"
mission: M2
covers: [M2-AC8]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m2/runs/RUN-2026-10-05-002.md}
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

The solo copy's real uwb-ranging-ingest-vendor-v01 campaign: a title it does not contain ('M9 - No such mission': set-status.js exits 1 and writes nothing), and its real M1 ('M1 - Venue ingest mode and vendor integer ids', status done) as the mission that is moved through real transitions. The work log is the copy's real `.octobots/tokenomics/worklog.jsonl`. The hook payload carries the REAL stdout of each set-status.js call as `tool_response.stdout` (the field Claude Code's PostToolUse Bash sends, stderr merged, trailing newline stripped); nothing is typed by hand except the forged-echo steps, whose point is that they are forgeries.

## Commands

```bash
cd $WORK/solo
C=.octobots/campaigns/uwb-ranging-ingest-vendor-v01
M1="M1 - Venue ingest mode and vendor integer ids"
SS=.claude/skills/mission-planner/scripts/set-status.js
Y=$(ls -d $C/missions/m1-*)/mission.yaml
WL=.octobots/tokenomics/worklog.jsonl; touch $WL
# PostToolUse JSON for a command whose real output was $2 (pass the literal word NONE to omit tool_response)
payload() { node -e 'const [c,o]=process.argv.slice(1);const e={session_id:"qa-m2-tc012",tool_name:"Bash",cwd:process.cwd(),tool_input:{command:c}};if(o!=="NONE")e.tool_response={stdout:o.replace(/\n$/,""),stderr:""};console.log(JSON.stringify(e))' "$1" "$2"; }
# run both hooks on ($1 command, $2 real output); prints gate bytes and worklog line counts
hooks() { B=$(wc -l < $WL)
  payload "$1" "$2" | CLAUDE_PROJECT_DIR=$WORK/solo node $PACK/hooks/mission-gate.mjs > $WORK/gate.out; echo "gate exit=$? bytes=$(wc -c < $WORK/gate.out) relay=$(grep -ci relay $WORK/gate.out)"
  payload "$1" "$2" | CLAUDE_PROJECT_DIR=$WORK/solo node $PACK/hooks/work-log.mjs; echo "work-log exit=$? lines $B -> $(wc -l < $WL)"; }
# (a) nothing written: the title does not exist, and `; echo` makes the Bash call exit 0
CMD="node $SS $C \"M9 - No such mission\" done; echo"
OUT=$(sh -c "$CMD" 2>&1); echo "chain exit=$? out=$OUT"; hooks "$CMD" "$OUT"
# (b) setup, no hooks fed: put the real M1 back to executing
node $SS $C "$M1" executing; grep ^status $Y
# (c) REAL transition executing -> done, real stdout in the payload
CMD2="node $SS $C \"$M1\" done"
OUT2=$(sh -c "$CMD2" 2>&1); echo "$OUT2"; grep ^status $Y; hooks "$CMD2" "$OUT2"; tail -1 $WL
# (d) re-run done on the now-done mission: real `unchanged` stdout
H=$(shasum $Y); T=$(stat -f %m $Y)
OUT3=$(sh -c "$CMD2" 2>&1); echo "$OUT3"; hooks "$CMD2" "$OUT3"
echo "yaml identical=$([ "$H" = "$(shasum $Y)" ] && echo yes || echo NO) mtime same=$([ $T = $(stat -f %m $Y) ] && echo yes || echo NO)"
# (e) a plain echo of the command (B3's "echo of it"): stdout is just the command text
hooks "echo $CMD2" "$(sh -c "echo $CMD2")"
# (f) no tool_response at all, on a command that did not just transition
hooks "$CMD2" NONE
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/octobots-mission-gate.test.ts test/octobots-work-log.test.ts --reporter=verbose
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the no-such-mission command chained with `; echo` | set-status.js prints 'no entity named ...'; the chain exits 0 |
| 2 | Feed that command's PostToolUse JSON (real stdout) to mission-gate.mjs | Exit 0 and 0 bytes printed: no gate directive |
| 3 | Feed it to work-log.mjs and compare worklog.jsonl line counts | Exit 0; line count unchanged |
| 4 | Real transition: set M1 to executing (setup), then really run `set-status ... done` and feed its real stdout (`octobots: status mission "<M1>" executing -> done`) to both hooks | The YAML reads done; mission-gate prints the directive (relay count >= 1); work-log appends exactly one `{"mission":"M1","state":"done"}` line |
| 5 | Re-run: really run the same `done` command on the now-done mission and feed its real stdout (`octobots: status mission "<M1>" unchanged (done)`) to both hooks | set-status.js exits 0 and the YAML is byte-identical with the same mtime; mission-gate prints 0 bytes; work-log line count unchanged |
| 6 | Feed a plain `echo <the done command>` (stdout = the command text) and then the done command with no `tool_response` | Both hooks silent: 0 bytes, no new work-log line |
| 7 | Run the two hook vitest files | At least 1 test passed in each |

## Expected Final State

A set-status.js call that changed nothing (not found, or already in the requested state) produces no gate directive and no work-log line; a real status change, proven by the real set-status.js output, still does.

## Teardown

- None (the copy is discarded with $WORK).
