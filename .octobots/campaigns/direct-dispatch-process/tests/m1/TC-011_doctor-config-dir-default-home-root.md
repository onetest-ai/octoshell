---
id: TC-011
title: "doctor.js treats ~/.claude/projects as the default transcript root and never advises CLAUDE_CONFIG_DIR=<repo>/.claude"
mission: M1
covers: [M1-AC8]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m1/runs/RUN-2026-10-05-001.md}
priority: high
size: S
---

# TC-011: doctor.js treats ~/.claude/projects as the default transcript root and never advises CLAUDE_CONFIG_DIR=<repo>/.claude

**Mission:** M1 | **Priority:** high | **Kind:** cli | **Covers:** M1-AC8

## Objective

doctor.js treats ~/.claude/projects as the default transcript root and never advises CLAUDE_CONFIG_DIR=<repo>/.claude. Verifies M1-AC8 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; mission branch built).
- doctor.js only reads; it runs from the pack path against real checkouts.

## Real data (pre-existing record)

The real octoshell checkout, where the v56 doctor.js reports `{level: "warn", area: "config-dir"}` with the fix `export CLAUDE_CONFIG_DIR="<repo>/.claude"` (observed 2026-10-05), and the real solo checkout, whose transcripts live under ~/.claude/projects/-Users-arozumenko-Development-auqanautica.

## Commands

```bash
for R in $OCTO $SOLO; do
  (cd $R && env -u CLAUDE_CONFIG_DIR node $PACK/skill/mission-planner/scripts/doctor.js --json | jq -c '.findings[]|select(.area=="config-dir")')
done
(cd $SOLO && env -u CLAUDE_CONFIG_DIR node $PACK/skill/mission-planner/scripts/doctor.js --json | jq -r '.findings[]|select(.area=="config-dir")|.msg+" "+(.fix//"")' | grep -c -F "$SOLO/.claude")
(cd $SOLO && CLAUDE_CONFIG_DIR=$WORK/cfg node $PACK/skill/mission-planner/scripts/doctor.js --json | jq -c '.findings[]|select(.area=="config-dir")')
cd $OCTO && pnpm --filter @octoshell/board exec vitest run test/scripts-cli-scenarios.test.ts -t "config-dir" --reporter=verbose
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | doctor.js --json on octoshell and on solo with CLAUDE_CONFIG_DIR unset | The config-dir finding has level `ok` and names ~/.claude/projects/<slug> as the root the collector reads |
| 2 | Search the output for the old advice | 0 occurrences of `CLAUDE_CONFIG_DIR=<repo>/.claude` |
| 3 | doctor.js with CLAUDE_CONFIG_DIR=$WORK/cfg | The finding names $WORK/cfg/projects/<slug> as the root |
| 4 | Run the config-dir scenarios | At least 1 test passed |

## Expected Final State

The doctor no longer pushes users toward the legacy repo-local root.
