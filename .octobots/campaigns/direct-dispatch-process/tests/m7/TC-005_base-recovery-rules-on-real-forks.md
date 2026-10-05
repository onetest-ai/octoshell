---
id: TC-005
title: "Base recovery picks solo's true v56 base from git, the earliest v57 build without git, and never the closest-by-diff v50"
mission: M7
covers: [M7-AC2]
kind: unit
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m7/runs/RUN-2026-10-05-001.md}
priority: high
size: M
---

# TC-005: Base recovery picks solo's true v56 base from git, the earliest v57 build without git, and never the closest-by-diff v50

**Mission:** M7 | **Priority:** high | **Kind:** unit | **Covers:** M7-AC2

## Objective

The base rules give the right base on the real forks, in the right order. Verifies M7-AC2 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP, SCRATCH; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

Solo's real forks and git history (commit 7de91fef holds the shipped v56 files); the shipped-skill store; the first v57 build 800c62c (the v56 text plus the marker). The vitest builds temp repos from these real bytes.

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/pack-deviations.test.ts --reporter=verbose
gitcopy solo5; mkdir -p $WORK/solo5plain && cp -R $SOLO/.claude $SOLO/.octobots $WORK/solo5plain/
for w in solo5 solo5plain; do $IP $WORK/$w > /dev/null 2>&1; echo "$w:"; jq -c '.skills[] | {skill, base}' $WORK/$w/.octobots/pack-updates/pending.json; done
for s in mission-execution mission-completion-gate; do git -C $OCTO show 800c62c:apps/vscode-extension/resources/octobots-pack/skill/$s/SKILL.md | cmp - $WORK/solo5plain/.octobots/pack-updates/v57/$s/base.md && echo "$s plain base = 800c62c"; done
# contrast, not product code: what closest-by-diff alone would pick (campaign notes § Real-data notes)
for s in mission-execution mission-completion-gate; do node $SCRATCH/reconcile-spike/base-rules.mjs $SOLO $s; done
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run pack-deviations.test.ts | At least 1 test passed, none failed (rule order 1-5) |
| 2 | Git copy | Both entries: base {version 56, source workspace-git}, sha256 9af2c928b831... and 008de10a952f... |
| 3 | Plain copy (no git) | Both entries: base {version 57, source declared}; base.md equals the 800c62c file (the earliest v57 body, not a later intermediate v57 build) |
| 4 | Run the spike for contrast | Closest-by-diff alone does NOT pick the true v56 base: rule4_closest_v50plus is a later body (observed 2026-10-05: v57, distance 61 for mission-execution and 27 for the gate; at planning time, before the v57 builds were in the history, v50 / v51); only rule 2 (workspace git) finds v56. That is why closest-by-diff is the last rule |

## Expected Final State

The base a reconcile starts from is the one the fork really came from, or the conservative older one.
