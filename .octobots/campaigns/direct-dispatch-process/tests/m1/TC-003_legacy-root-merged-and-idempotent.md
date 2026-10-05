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

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, SLUG; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on frozen copies.

## Real data (pre-existing record)

A frozen `cp -R` copy of the real solo home slug dir (real transcripts, copied so the live planning session 011deac1 cannot grow mid-case), placed as both roots of a disposable project dir $WORK/proj: the home root via `--projects-dir`, and the legacy root at `$WORK/proj/.claude/projects/<slug of $WORK/proj>`. The legacy root is always the MAIN checkout's, so a worktree cannot host this case.

## Commands

```bash
P=$WORK/proj; mkdir -p $P
PSLUG=$(node -e 'console.log(process.argv[1].replace(/[^A-Za-z0-9]/g,"-"))' "$P")
mkdir -p $WORK/home-root/$PSLUG $P/.claude/projects/$PSLUG
cp -R $HOME/.claude/projects/$SLUG/. $WORK/home-root/$PSLUG/          # frozen copy of the real home root
S=$(ls -S $WORK/home-root/$PSLUG/*.jsonl | head -1); SID=$(basename "$S" .jsonl)
cp "$S" $P/.claude/projects/$PSLUG/                                      # the same session in the legacy root
node $PACK/tokenomics/collect.mjs --project-dir $P --projects-dir $WORK/home-root; cp $P/.octobots/tokenomics/raw/segments.jsonl $WORK/seg.1
node $PACK/tokenomics/collect.mjs --project-dir $P --projects-dir $WORK/home-root; cmp $WORK/seg.1 $P/.octobots/tokenomics/raw/segments.jsonl && echo IDENTICAL
node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);const ids=l.filter(s=>s.session_id===process.argv[2]).map(s=>s.segment_id);console.log("segments of",process.argv[2],ids.length,"distinct",new Set(ids).size)' $WORK/seg.1 $SID
head -n $(( $(wc -l < "$S") / 2 )) "$S" > $P/.claude/projects/$PSLUG/$SID.jsonl     # legacy copy now has fewer turns
node $PACK/tokenomics/collect.mjs --project-dir $P --projects-dir $WORK/home-root; cmp $WORK/seg.1 $P/.octobots/tokenomics/raw/segments.jsonl && echo MORE_TURNS_WINS
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Build the disposable project dir with the largest real session in both roots | The session exists in the home root copy and in the legacy root |
| 2 | Run collect.mjs twice and `cmp` the two segments.jsonl files | Byte-identical (IDENTICAL printed) |
| 3 | Count segment_id values for that session: total vs distinct | No duplicates: total == distinct, and total > 0 |
| 4 | Truncate the legacy copy to half its lines and rerun | Output unchanged (MORE_TURNS_WINS): the copy with more turns (home) wins |

## Expected Final State

The session appears once, the larger copy wins, and repeated runs are byte-identical.

## Teardown

- `rm -rf $WORK/proj $WORK/home-root $WORK/seg.1`
