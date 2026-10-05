---
id: TC-002
title: "CLAUDE_CONFIG_DIR and --projects-dir/env override the home root, in that order"
mission: M1
covers: [M1-AC2]
kind: cli
status: draft
priority: high
size: M
---

# TC-002: CLAUDE_CONFIG_DIR and --projects-dir/env override the home root, in that order

**Mission:** M1 | **Priority:** high | **Kind:** cli | **Covers:** M1-AC2

## Objective

CLAUDE_CONFIG_DIR and --projects-dir/env override the home root, in that order. Verifies M1-AC2 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

a `cp -R` COPY of the real solo slug dir (in $WORK) as the override root, so the result is comparable to TC-001

## Commands

```bash
mkdir -p $WORK/cfg/projects && cp -R ~/.claude/projects/-Users-arozumenko-Development-auqanautica $WORK/cfg/projects/
mkdir -p $WORK/other/ && cp -R ~/.claude/projects/-Users-arozumenko-Development-auqanautica $WORK/other/
cd $SOLO/.claude/worktrees/qa-m1
# (a) config dir replaces ~
HOME=$WORK/emptyhome CLAUDE_CONFIG_DIR=$WORK/cfg node $PACK/tokenomics/collect.mjs --project-dir "$PWD"; wc -l .octobots/tokenomics/raw/segments.jsonl
# (b) env override beats config dir; (c) --projects-dir beats env
OCTOBOTS_TOKENOMICS_PROJECTS_DIR=$WORK/other CLAUDE_CONFIG_DIR=$WORK/cfg HOME=$WORK/emptyhome node $PACK/tokenomics/collect.mjs --project-dir "$PWD"
HOME=$WORK/emptyhome node $PACK/tokenomics/collect.mjs --project-dir "$PWD" --projects-dir $WORK/other
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Build the two override roots as copies of the real slug dir; make $WORK/emptyhome an empty HOME | Roots exist |
| 2 | (a) Run with HOME=empty and CLAUDE_CONFIG_DIR=$WORK/cfg | Segments equal TC-001's segment count (the config dir's projects/<slug> replaced ~/.claude/projects) |
| 3 | Delete $WORK/cfg/projects/<slug> and rerun (a) | 0 segments: proves the config dir, not the real home, was read |
| 4 | (b) env OCTOBOTS_TOKENOMICS_PROJECTS_DIR=$WORK/other with CLAUDE_CONFIG_DIR still set | Segments come from $WORK/other (non-zero) even though cfg is now empty |
| 5 | (c) `--projects-dir $WORK/other` with no env | Same segments as (b) |

## Expected Final State

Each override root replaces the previous one in the stated order; results equal the real-home run when the root is a copy of the real slug dir.

## Teardown

- `rm -rf $WORK/cfg $WORK/other $WORK/emptyhome`
