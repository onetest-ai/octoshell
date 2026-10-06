---
id: TC-002
title: "CLAUDE_CONFIG_DIR and --projects-dir/env override the home root, in that order"
mission: M1
covers: [M1-AC2]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m1/runs/RUN-2026-10-05-001.md}
priority: high
size: M
---

# TC-002: CLAUDE_CONFIG_DIR and --projects-dir/env override the home root, in that order

**Mission:** M1 | **Priority:** high | **Kind:** cli | **Covers:** M1-AC2

## Objective

CLAUDE_CONFIG_DIR and --projects-dir/env override the home root, in that order. Verifies M1-AC2 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, SLUG; the qa-m1 worktree from TC-001).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

`cp -R` copies of the real solo home slug dir in $WORK, used as override roots. The discriminator is the 3 home-only sessions (011deac1, 138ca3b0, 39d8025a): they appear only when the root under test is read. Solo's legacy main-checkout root is read in addition in every run, so it is never expected to be empty.

## Commands

```bash
cd $SOLO/.claude/worktrees/qa-m1
mkdir -p $WORK/emptyhome $WORK/cfg/projects $WORK/other $WORK/empty-projects
cp -R $HOME/.claude/projects/$SLUG $WORK/cfg/projects/
cp -R $HOME/.claude/projects/$SLUG $WORK/other/
sessions() { node -e 'const l=require("fs").readFileSync(".octobots/tokenomics/raw/segments.jsonl","utf8").trim().split("\n").filter(Boolean).map(JSON.parse);const ids=new Set(l.map(s=>s.session_id.slice(0,8)));console.log("home-only:",["011deac1","138ca3b0","39d8025a"].filter(p=>ids.has(p)).join(" ")||"none","| sessions:",ids.size)'; }
# (a) CLAUDE_CONFIG_DIR replaces ~/.claude
rm -f .octobots/tokenomics/raw/segments.jsonl; HOME=$WORK/emptyhome CLAUDE_CONFIG_DIR=$WORK/cfg node $PACK/tokenomics/collect.mjs --project-dir "$PWD"; sessions
# (a2) the same with the config dir's slug moved away
mv $WORK/cfg/projects/$SLUG $WORK/cfg-slug.aside
rm -f .octobots/tokenomics/raw/segments.jsonl; HOME=$WORK/emptyhome CLAUDE_CONFIG_DIR=$WORK/cfg node $PACK/tokenomics/collect.mjs --project-dir "$PWD"; sessions
# (b) env beats CLAUDE_CONFIG_DIR
rm -f .octobots/tokenomics/raw/segments.jsonl; HOME=$WORK/emptyhome CLAUDE_CONFIG_DIR=$WORK/cfg OCTOBOTS_TOKENOMICS_PROJECTS_DIR=$WORK/other node $PACK/tokenomics/collect.mjs --project-dir "$PWD"; sessions
# (c) --projects-dir beats env
rm -f .octobots/tokenomics/raw/segments.jsonl; HOME=$WORK/emptyhome OCTOBOTS_TOKENOMICS_PROJECTS_DIR=$WORK/empty-projects node $PACK/tokenomics/collect.mjs --project-dir "$PWD" --projects-dir $WORK/other; sessions
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Build the override roots as copies of the real slug dir; make $WORK/emptyhome an empty HOME | Roots exist |
| 2 | (a) HOME=empty, CLAUDE_CONFIG_DIR=$WORK/cfg | home-only: 011deac1 138ca3b0 39d8025a (the config dir's projects/<slug> replaced ~/.claude/projects) |
| 3 | (a2) move the config dir's slug away and rerun (a) | home-only: none, sessions > 0 (only the legacy root remains): the config dir, not the real home, was read |
| 4 | (b) OCTOBOTS_TOKENOMICS_PROJECTS_DIR=$WORK/other with CLAUDE_CONFIG_DIR still set | home-only: all three (from $WORK/other), although the config dir now has no slug |
| 5 | (c) `--projects-dir $WORK/other` while the env points at an empty root | home-only: all three: the flag beat the env |

## Expected Final State

Each override replaces the previous root in the stated order (--projects-dir > env > CLAUDE_CONFIG_DIR > ~), and the legacy main-checkout root is read in addition every time.

## Teardown

- `rm -rf $WORK/cfg $WORK/other $WORK/emptyhome $WORK/empty-projects $WORK/cfg-slug.aside`
