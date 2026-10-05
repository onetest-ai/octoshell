---
id: TC-017
title: "One marker rule and one pending.json shape across host and pack, including CRLF files and a malformed record"
mission: M7
covers: [M7-AC1, M7-AC3]
kind: unit
status: draft
priority: high
size: S
---

# TC-017: One marker rule and one pending.json shape across host and pack, including CRLF files and a malformed record

**Mission:** M7 | **Priority:** high | **Kind:** unit | **Covers:** M7-AC1, M7-AC3

## Objective

The extension, doctor.js, validate.js, primer.mjs and pack-reconcile.mjs classify skills and read the pending record the same way, so a Windows checkout or a broken file never gives two answers. Verifies M7-AC1 and M7-AC3 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP; the gitcopy helper; mission branch built).

## Real data (pre-existing record)

Solo's real `57-local` mission-execution fork, converted to CRLF on a copy (derived, stated), and the committed fixture file apps/vscode-extension/test/fixtures/pending-cases.json.

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/skill-marker-parity.test.ts test/pending-io-parity.test.ts --reporter=verbose
mkdir -p $WORK/solo17 && cp -R $SOLO/.claude $SOLO/.octobots $WORK/solo17/
for s in mission-planner knowledge-explorer; do awk '{printf "%s\r\n", $0}' $WORK/solo17/.claude/skills/$s/SKILL.md > $WORK/crlf && mv $WORK/crlf $WORK/solo17/.claude/skills/$s/SKILL.md; done
$IP $WORK/solo17 2>/dev/null | jq -c '[.deviations[].skill]'
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the two parity vitest files | At least 1 test passed in each, none failed |
| 2 | Install into a copy whose pristine v56 mission-planner and knowledge-explorer were converted to CRLF | Deviations are only mission-execution and mission-completion-gate: CRLF files hash as their LF originals and are not `content` deviations |

## Expected Final State

Line endings and a broken record never change the classification.
