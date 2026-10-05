---
id: TC-001
title: "Collect from a solo worktree reads ~/.claude/projects/<slug>, and only solo's slug"
mission: M1
covers: [M1-AC1]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m1/runs/RUN-2026-10-05-001.md}
priority: critical
size: M
---

# TC-001: Collect from a solo worktree reads ~/.claude/projects/<slug>, and only solo's slug

**Mission:** M1 | **Priority:** critical | **Kind:** cli | **Covers:** M1-AC1

## Objective

Collect from a solo worktree reads ~/.claude/projects/<slug>, and only solo's slug. Verifies M1-AC1 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, SLUG; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works in a disposable worktree.

## Real data (pre-existing record)

The real home slug dir `$HOME/.claude/projects/-Users-arozumenko-Development-auqanautica`, whose 3 sessions (011deac1, 138ca3b0, 39d8025a) exist nowhere else, plus solo's legacy main-checkout root `$SOLO/.claude/projects/<slug>` (6 other sessions). Other projects' slug dirs next to them (e.g. octoshell's) must NOT contribute.

## Commands

```bash
git -C $SOLO worktree add $SOLO/.claude/worktrees/qa-m1 HEAD
cd $SOLO/.claude/worktrees/qa-m1
rm -f .octobots/tokenomics/raw/segments.jsonl     # inspect only a fresh collection (collect.mjs merges into an existing file)
node $PACK/tokenomics/collect.mjs --project-dir "$PWD"; echo "exit=$?"
node -e '
const fs=require("fs");
const l=fs.readFileSync(".octobots/tokenomics/raw/segments.jsonl","utf8").trim().split("\n").map(JSON.parse);
const slug="-Users-arozumenko-Development-auqanautica";
const roots=[process.env.HOME+"/.claude/projects/"+slug, process.argv[1]+"/.claude/projects/"+slug];
const have=new Set(roots.flatMap(d=>fs.existsSync(d)?fs.readdirSync(d).map(f=>f.replace(/\.jsonl$/,"")):[]));
const ids=[...new Set(l.map(s=>s.session_id))];
console.log("segments",l.length,"sessions",ids.length);
console.log("project_slug values",JSON.stringify([...new Set(l.map(s=>s.project_slug))]));
console.log("sessions in neither solo root:",ids.filter(i=>!have.has(i)).length);
console.log("home-only present:",["011deac1","138ca3b0","39d8025a"].map(p=>p+"="+ids.some(i=>i.startsWith(p))).join(" "));' "$SOLO"
git -C $SOLO status --short .octobots/tokenomics
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Create the disposable worktree, `cd` into it and remove its committed raw/segments.jsonl | Worktree created under $SOLO/.claude/worktrees/qa-m1 |
| 2 | Run the pack collect.mjs with `--project-dir` = the worktree | Exit 0; raw/segments.jsonl written inside the WORKTREE's .octobots/tokenomics/ |
| 3 | Count segments, sessions and `project_slug` values | Segment count > 0; `project_slug` is only `-Users-arozumenko-Development-auqanautica` |
| 4 | Check every session_id against the two solo roots | 0 sessions in neither solo root (no other project's sessions) |
| 5 | Check the home-only sessions | 011deac1, 138ca3b0 and 39d8025a are all present: the home root was read |
| 6 | `git -C $SOLO status --short .octobots/tokenomics` | Empty: solo's committed tokenomics untouched |

## Expected Final State

A fresh segments.jsonl in the worktree holds the three home-only sessions and nothing from another project's slug; solo's own .octobots/tokenomics is unchanged.

## Teardown

- Keep the worktree for TC-002..TC-011; remove it at the end with `git -C $SOLO worktree remove --force $SOLO/.claude/worktrees/qa-m1`.
