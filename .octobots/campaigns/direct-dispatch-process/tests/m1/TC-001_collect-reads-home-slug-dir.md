---
id: TC-001
title: "Collect from a solo worktree reads ~/.claude/projects/<slug> only"
mission: M1
covers: [M1-AC1]
kind: cli
status: draft
priority: critical
size: M
---

# TC-001: Collect from a solo worktree reads ~/.claude/projects/<slug> only

**Mission:** M1 | **Priority:** critical | **Kind:** cli | **Covers:** M1-AC1

## Objective

Collect from a solo worktree reads ~/.claude/projects/<slug> only. Verifies M1-AC1 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

slug dir ~/.claude/projects/-Users-arozumenko-Development-auqanautica (real); other project dirs next to it (e.g. the octoshell slug dir) must NOT contribute

## Commands

```bash
git -C $SOLO worktree add $SOLO/.claude/worktrees/qa-m1 HEAD
cd $SOLO/.claude/worktrees/qa-m1
ls ~/.claude/projects | head -20
node $PACK/tokenomics/collect.mjs --project-dir "$PWD"
wc -l .octobots/tokenomics/raw/segments.jsonl
node -e 'const l=require("fs").readFileSync(".octobots/tokenomics/raw/segments.jsonl","utf8").trim().split("\n").map(JSON.parse);console.log(new Set(l.map(s=>s.sessionId)).size,"sessions");console.log([...new Set(l.map(s=>s.cwd||s.project||""))].slice(0,5))'
# every session id must exist as a .jsonl under the solo slug dir:
node -e 'const fs=require("fs");const d=process.env.HOME+"/.claude/projects/-Users-arozumenko-Development-auqanautica";const l=fs.readFileSync(".octobots/tokenomics/raw/segments.jsonl","utf8").trim().split("\n").map(JSON.parse);const have=new Set(fs.readdirSync(d).map(f=>f.replace(/\.jsonl$/,"")));const bad=l.filter(s=>!have.has(s.sessionId));console.log("segments with session not in solo slug dir:",bad.length)'
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Create the disposable worktree and `cd` into it | Worktree created under $SOLO/.claude/worktrees/qa-m1 |
| 2 | Run the pack collect.mjs with `--project-dir` = the worktree | Exit 0; raw/segments.jsonl written inside the WORKTREE's .octobots/tokenomics/ |
| 3 | Count segments and distinct session ids | Segment count > 0 (real sessions exist) |
| 4 | Check every session id against the files in the solo slug dir | 0 segments reference a session that is not in the solo slug dir (no other project's sessions) |
| 5 | `git -C $SOLO status --short .octobots/tokenomics` | Empty: solo's committed tokenomics untouched |

## Expected Final State

segments.jsonl exists in the worktree, is non-empty, and every segment's session is a file under the solo slug dir; solo's own .octobots/tokenomics is unchanged.

## Teardown

- `git -C $SOLO worktree remove --force $SOLO/.claude/worktrees/qa-m1`
