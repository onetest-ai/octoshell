---
id: TC-007
title: "Extension build (--verify) passes; graph-payload.test.ts green on 57"
mission: M3
covers: [M3-AC6, M3-AC7]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m3/runs/RUN-2026-10-05-001.md}
priority: high
size: S
---

# TC-007: Extension build (--verify) passes; graph-payload.test.ts green on 57

**Mission:** M3 | **Priority:** high | **Kind:** cli | **Covers:** M3-AC6, M3-AC7

## Objective

Extension build (--verify) passes; graph-payload.test.ts green on 57. Verifies M3-AC6 and M3-AC7 of M3 - Extension and board library drop Workflow entities.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

the real regenerated apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs and scripts/graph-payload-versions.json (diff line for the 57 hash visible in git)

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension build && pnpm --filter @octoshell/vscode-extension exec vitest run test/graph-payload.test.ts --reporter=verbose
git diff origin/main -- apps/vscode-extension/scripts/graph-payload-versions.json | grep '^[+-].*"57"'
pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm coverage
# docs and knowledge notes (M3-AC7 docs part): must print nothing
grep -n -i -E 'workflow\.js|WorkflowView|workflow-designer|workflow-diagram|workflow pack|Install Workflow Pack' README.md apps/vscode-extension/README.md CLAUDE.md AGENTS.md .agents/knowledge/architecture/pack-version-is-one-unit.md .agents/knowledge/architecture/dual-schema-entity-io.md
# the new name everywhere the old one was quoted
grep -c 'Install Workflow Pack' $PACK/skill/mission-planner/scripts/doctor.js          # 0
grep -c 'Install Octobots Pack' $PACK/skill/mission-planner/scripts/doctor.js          # >= 1
grep -n -i 'workflow pack' apps/vscode-extension/src/extension.ts; jq -r .description apps/vscode-extension/package.json
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Build the extension (runs graph-payload --verify) | Exit 0 |
| 2 | Run graph-payload.test.ts | At least 1 test passed, on version 57 |
| 3 | Diff the versions json against main | Exactly one changed line: the 57 hash (visible) |
| 4 | Run the full gates | lint, typecheck, build, test, coverage all green |
| 5 | grep the docs and knowledge notes for the workflow terms | No output |
| 6 | grep doctor.js, extension.ts and the package description | doctor.js: 0 'Install Workflow Pack', >= 1 'Install Octobots Pack'; extension.ts: no 'workflow pack'; the description says 'Octobots pack' |

## Expected Final State

Payload regenerated and pinned; repo gates green; docs, knowledge notes, doctor.js and the extension's own strings carry no workflow product language.
