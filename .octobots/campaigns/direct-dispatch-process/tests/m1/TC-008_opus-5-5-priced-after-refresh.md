---
id: TC-008
title: "claude-opus-5-5 and claude-sonnet-5-5 stay priced after update-prices.mjs; prices.local.json kept on re-install"
mission: M1
covers: [M1-AC6]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m1/runs/RUN-2026-10-05-001.md}
priority: high
size: M
---

# TC-008: claude-opus-5-5 and claude-sonnet-5-5 stay priced after update-prices.mjs; prices.local.json kept on re-install

**Mission:** M1 | **Priority:** high | **Kind:** cli | **Covers:** M1-AC6

## Objective

claude-opus-5-5 and claude-sonnet-5-5 stay priced after update-prices.mjs; prices.local.json kept on re-install. Verifies M1-AC6 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; the qa-m1 worktree from TC-001).
- update-prices.mjs rewrites the prices.json next to itself, so it only ever runs on the $WORK/pricing copy, never on $PACK.

## Real data (pre-existing record)

Solo's real prices.json lines for claude-opus-5-5 and claude-sonnet-5-5 (the source of the seeded prices.local.json), and solo's real segments, many of which used claude-opus-5-5.

## Commands

```bash
W=$WORK/pricing; mkdir -p $W && cp -R $PACK/tokenomics/. $W/
node -e 'const l=require(process.argv[1]),s=require(process.argv[2]);for(const m of ["claude-opus-5-5","claude-sonnet-5-5"])console.log(m,"local:",JSON.stringify((l.models||l)[m]),"solo:",JSON.stringify((s.models||s)[m]))' $W/prices.local.json $SOLO/.octobots/tokenomics/prices.json
node $W/update-prices.mjs; echo "refresh exit=$?"          # network (LiteLLM); with no network this half is UNREACHABLE
node -e 'const p=require(process.argv[1]);for(const m of ["claude-opus-5-5","claude-sonnet-5-5"])console.log(m,"in refreshed prices.json:",!!(p.models||p)[m])' $W/prices.json
cd $SOLO/.claude/worktrees/qa-m1 && node $PACK/tokenomics/collect.mjs --project-dir "$PWD" && node $W/rollup.mjs --project-dir "$PWD" --no-gh
node -e 'const r=require(process.argv[1]+"/.octobots/tokenomics/runs.json");const c={};for(const x of r.runs)for(const [m,v] of Object.entries(x.cost_by_model||{}))c[m]=(c[m]||0)+v;console.log(JSON.stringify({"claude-opus-5-5":c["claude-opus-5-5"],"claude-sonnet-5-5":c["claude-sonnet-5-5"]}))' "$PWD"
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/tokenomics-prices-local.test.ts --reporter=verbose
grep -c "claude-opus-5-5\|claude-sonnet-5-5" packages/tokenomics/src/prices.data.ts
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Compare the shipped prices.local.json with solo's prices.json | Both models present, values identical to solo's |
| 2 | Run the copy's update-prices.mjs | Exit 0 and prices.json refreshed; with no network, record this half UNREACHABLE (never stub LiteLLM) |
| 3 | Roll solo's real segments up with the refreshed copy | cost_by_model for claude-opus-5-5 (and claude-sonnet-5-5 if solo used it) is > 0, not undefined/0 |
| 4 | If the refreshed prices.json lists a model, recompute one segment's cost from prices.json's rates | It matches: upstream wins. If upstream lists neither model, this half is UNREACHABLE on real data (covered by T1.4's vitest) |
| 5 | Run tokenomics-prices-local.test.ts | At least 1 test passed: re-install keeps an edited prices.local.json byte-identical |
| 6 | grep prices.data.ts | Count >= 2: the extension's built-in table prices both models |

## Expected Final State

Hand-added prices survive a refresh, upstream wins on conflict, a re-install keeps the workspace copy, and the extension's table carries both models.
