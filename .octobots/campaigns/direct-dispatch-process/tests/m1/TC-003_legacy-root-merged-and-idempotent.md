---
id: TC-003
title: "Home and legacy repo-local roots merge; a session in both is counted once; rerun is byte-identical"
mission: M1
covers: [M1-AC3]
kind: cli
status: draft
priority: high
size: M
---

# TC-003: Home and legacy repo-local roots merge; a session in both is counted once; rerun is byte-identical

**Mission:** M1 | **Priority:** high | **Kind:** cli | **Covers:** M1-AC3

## Objective

Home and legacy repo-local roots merge; a session in both is counted once; rerun is byte-identical. Verifies M1-AC3 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

one real session jsonl from the solo slug dir, copied into $WORK/legacy/<slug>/ (a real file, not a synthesised one), plus solo's own <repo>/.claude/projects snapshot if present

## Commands

```bash
cd $SOLO/.claude/worktrees/qa-m1
S=$(ls -S ~/.claude/projects/-Users-arozumenko-Development-auqanautica/*.jsonl | head -1)
mkdir -p .claude/projects/-Users-arozumenko-Development-auqanautica && cp "$S" .claude/projects/-Users-arozumenko-Development-auqanautica/
node $PACK/tokenomics/collect.mjs --project-dir "$PWD"; cp .octobots/tokenomics/raw/segments.jsonl $WORK/seg.1
node $PACK/tokenomics/collect.mjs --project-dir "$PWD"; cmp $WORK/seg.1 .octobots/tokenomics/raw/segments.jsonl && echo IDENTICAL
SID=$(basename "$S" .jsonl); grep -c "$SID" $WORK/seg.1; node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);const ids=l.map(s=>s.id||s.segmentId);console.log(ids.length,new Set(ids).size)' $WORK/seg.1
# the copy with more turns wins: truncate the legacy copy to half its lines and confirm the home copy's turn count is used
head -n $(( $(wc -l < "$S") / 2 )) "$S" > .claude/projects/-Users-arozumenko-Development-auqanautica/$(basename "$S")
node $PACK/tokenomics/collect.mjs --project-dir "$PWD"; cmp $WORK/seg.1 .octobots/tokenomics/raw/segments.jsonl && echo MORE_TURNS_WINS
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Place a real session file (the largest one) in the worktree's legacy <repo>/.claude/projects/<slug>/ as well as the home root | The session exists in both roots |
| 2 | Run collect.mjs twice and `cmp` the two segments.jsonl files | Byte-identical (IDENTICAL printed) |
| 3 | Count segment ids for that session: total vs distinct | No duplicates: total == distinct |
| 4 | Truncate the legacy copy to half its lines and rerun | Output unchanged: the copy with more turns (home) wins |

## Expected Final State

The session appears once, the larger copy wins, and repeated runs are byte-identical.

## Teardown

- `git -C $SOLO worktree remove --force $SOLO/.claude/worktrees/qa-m1  (after TC-009 if reusing it)`
