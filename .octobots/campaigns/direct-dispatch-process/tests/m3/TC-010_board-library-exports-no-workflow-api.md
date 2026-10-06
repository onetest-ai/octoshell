---
id: TC-010
title: "@octoshell/board exports no Workflow API; EntityKind has 4 kinds; acorn removed"
mission: M3
covers: [M3-AC1]
kind: unit
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m3/runs/RUN-2026-10-05-001.md}
priority: critical
size: S
---

# TC-010: @octoshell/board exports no Workflow API; EntityKind has 4 kinds; acorn removed

**Mission:** M3 | **Priority:** critical | **Kind:** unit | **Covers:** M3-AC1

## Objective

@octoshell/board exports no Workflow API; EntityKind has 4 kinds; acorn removed. Verifies M3-AC1 of M3 - Extension and board library drop Workflow entities.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

the real built packages/board dist and package.json

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/board build
node -e 'import(process.argv[1]).then(m=>{const bad=Object.keys(m).filter(k=>/workflow|extractPhases|appendWorkflowRun/i.test(k));console.log("workflow exports:",bad);process.exit(bad.length?1:0)})' "$OCTO/packages/board/dist/index.js"
grep -n '"acorn"' packages/board/package.json; grep -rn "acorn" packages/board/src | head
awk '/^  packages\/board:/{s=1;next} /^  [^ ]/{s=0} s && /acorn/' pnpm-lock.yaml       # must print nothing
pnpm install --frozen-lockfile >/dev/null && echo LOCKFILE_OK
grep -n "EntityKind" packages/board/src/managed-block.ts packages/board/src/types.ts
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Enumerate the built module's exports | No name matching Workflow*, parseWorkflowMeta, extractPhases, createWorkflow, deleteWorkflow, appendWorkflowRun, migrateLegacyWorkflows |
| 2 | Check package.json, src and pnpm-lock.yaml's packages/board importer | No acorn dependency, import or lock entry; `pnpm install --frozen-lockfile` succeeds |
| 3 | Read EntityKind | campaign | mission | task | bug only |
| 4 | Typecheck the extension against the board | Green |

## Expected Final State

The Workflow entity is gone from the library surface.
