---
id: TC-008
title: "claude-opus-5-5 stays priced after update-prices.mjs, online and offline"
mission: M1
covers: [M1-AC6]
kind: cli
status: draft
priority: high
size: M
---

# TC-008: claude-opus-5-5 stays priced after update-prices.mjs, online and offline

**Mission:** M1 | **Priority:** high | **Kind:** cli | **Covers:** M1-AC6

## Objective

claude-opus-5-5 stays priced after update-prices.mjs, online and offline. Verifies M1-AC6 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

solo's real prices.json lines for claude-opus-5-5 and claude-sonnet-5-5 (the source of the seeded prices.local.json)

## Commands

```bash
W=$WORK/pricing; mkdir -p $W/.octobots/tokenomics && cp $PACK/tokenomics/* $W/.octobots/tokenomics/ 2>/dev/null
grep -n "claude-opus-5-5\|claude-sonnet-5-5" $SOLO/.octobots/tokenomics/prices.json | head
jq 'has("claude-opus-5-5"), has("claude-sonnet-5-5")' $W/.octobots/tokenomics/prices.local.json
cd $W && node .octobots/tokenomics/update-prices.mjs        # network (LiteLLM)
node -e 'const r=require("./.octobots/tokenomics/prices.json");console.log(!!(r.models||r)["claude-opus-5-5"],!!(r.models||r)["claude-sonnet-5-5"])'
node .octobots/tokenomics/update-prices.mjs --offline || true   # offline variant: refresh fails or no-ops, must not drop local prices
node .octobots/tokenomics/rollup.mjs --price-check claude-opus-5-5 2>&1 | head -3
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Confirm the seeded prices.local.json carries both models, equal to solo's real prices.json values | Both present, values identical to solo's |
| 2 | Run update-prices.mjs with network | prices.json refreshed; both models still priced (lookup returns a price, not undefined/0) |
| 3 | Run the offline variant | No crash; both models still priced from prices.local.json |
| 4 | If upstream also has claude-opus-5-5, compare | Upstream value wins over the local one |

## Expected Final State

Hand-added prices survive refresh in both online and offline modes; upstream wins on conflict. Network-less environments record the online half as UNREACHABLE (do not stub LiteLLM).
